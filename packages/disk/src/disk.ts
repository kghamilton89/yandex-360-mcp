import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TokenProvider } from 'yandex-360-oauth';
import { type DiskAccess, type DiskConfig, LOGIN_COMMAND } from './config.js';

type Fetch = typeof fetch;

/** A file or folder as the Disk REST API describes it. */
export interface Resource {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  created?: string;
  modified?: string;
  mime_type?: string;
  media_type?: string;
  md5?: string;
  sha256?: string;
  public_url?: string;
  origin_path?: string;
  deleted?: string;
  _embedded?: { items: Resource[]; total?: number; limit?: number; offset?: number };
}

interface Link {
  href: string;
  method?: string;
}

export class DiskError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

const RESOURCE_FIELDS = 'name,path,type,size,created,modified,mime_type,media_type,md5,sha256,public_url';
/** Largest file read_file and edit_file load whole. Bigger files go through download_file. */
export const MAX_EDIT_BYTES = 5 * 1024 * 1024;

/**
 * Turns a user path into an API path. "/Documents/a.txt" is relative to the Disk root in full
 * mode and to the app folder in app-folder mode; "disk:/", "app:/" and "trash:/" pass through.
 */
export function toApiPath(p: string, access: DiskAccess): string {
  const trimmed = p.trim();
  if (/^(disk|app|trash):/.test(trimmed)) return trimmed;
  const rooted = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return `${access === 'app-folder' ? 'app:' : 'disk:'}${rooted.replace(/\/+$/, '') || '/'}`;
}

/** Splits "disk:/a/b/c.txt" into its root ("disk:") and folder chain ["/a", "/a/b"]. */
export function parentFolders(apiPath: string): { root: string; folders: string[] } {
  const m = /^([a-z]+:)(\/.*)$/.exec(apiPath);
  if (!m) return { root: '', folders: [] };
  const parts = m[2]!.split('/').filter(Boolean).slice(0, -1);
  return { root: m[1]!, folders: parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`) };
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(homedir(), p.slice(1)) : p;
}

export function summarize(r: Resource) {
  return {
    name: r.name,
    path: r.path,
    type: r.type,
    ...(r.size !== undefined ? { size: r.size } : {}),
    ...(r.modified ? { modified: r.modified } : {}),
    ...(r.mime_type ? { mime_type: r.mime_type } : {}),
    ...(r.public_url ? { public_url: r.public_url } : {}),
  };
}

/** Counts occurrences of `needle` in `haystack`, without overlaps. */
function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

export interface TextEdit {
  old_text: string;
  new_text: string;
  replace_all?: boolean;
}

/** Applies exact-text replacements in order. Each old_text must occur once unless replace_all is set. */
export function applyEdits(text: string, edits: TextEdit[]): { text: string; replacements: number } {
  let out = text;
  let replacements = 0;
  edits.forEach((e, i) => {
    const label = edits.length > 1 ? `Edit ${i + 1}: ` : '';
    if (!e.old_text) throw new Error(`${label}old_text is empty`);
    const count = countOccurrences(out, e.old_text);
    if (count === 0) throw new Error(`${label}old_text was not found in the file. Read the file again and copy the text exactly.`);
    if (count > 1 && !e.replace_all) {
      throw new Error(`${label}old_text occurs ${count} times. Include more surrounding text to make it unique, or set replace_all.`);
    }
    out = e.replace_all ? out.split(e.old_text).join(e.new_text) : out.replace(e.old_text, () => e.new_text);
    replacements += e.replace_all ? count : 1;
  });
  return { text: out, replacements };
}

/** Decodes UTF-8 text, refusing binary content. `partial` allows a cut-off final character. */
export function decodeText(bytes: Uint8Array, partial: boolean): string {
  if (bytes.includes(0)) throw new Error('This looks like a binary file. Use download_file to save it locally instead.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: partial });
  } catch {
    throw new Error('This file is not UTF-8 text. Use download_file to save it locally instead.');
  }
}

export interface ServiceOptions {
  fetchImpl?: Fetch;
  tokens?: Pick<TokenProvider, 'getAccessToken' | 'refresh' | 'canRefresh'>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export class DiskService {
  private readonly fetchImpl: Fetch;
  private readonly tokens: Pick<TokenProvider, 'getAccessToken' | 'refresh' | 'canRefresh'>;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(
    private readonly cfg: DiskConfig,
    opts: ServiceOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.tokens = opts.tokens ?? new TokenProvider(cfg.oauth, this.fetchImpl);
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 30_000;
  }

  private p(userPath: string): string {
    return toApiPath(userPath, this.cfg.access);
  }

  private async error(res: Response, subject?: string): Promise<DiskError> {
    const body = (await res.json().catch(() => ({}))) as { error?: string; description?: string; message?: string };
    const detail = body.description || body.message || res.statusText || 'request failed';
    const what = subject ? ` (${subject})` : '';
    switch (res.status) {
      case 401:
        return new DiskError(`Yandex rejected the Disk login: it may have expired or been revoked. Run \`${LOGIN_COMMAND}\` again.`, 401, body.error);
      case 403:
        return new DiskError(
          `Not allowed${what}: ${detail}.` +
            (this.cfg.access === 'app-folder' ? ' In app-folder mode the server can only reach its own folder.' : ''),
          403,
          body.error,
        );
      case 404:
        return new DiskError(`Not found${what}. Check the path with list_folder.`, 404, body.error);
      case 423:
        return new DiskError(`The resource is locked by another operation${what}. Try again shortly.`, 423, body.error);
      case 429:
        return new DiskError(`Yandex Disk is rate limiting requests. Wait a moment and try again.`, 429, body.error);
      case 507:
        return new DiskError(`Not enough space on Yandex Disk${what}.`, 507, body.error);
      default:
        return new DiskError(`Yandex Disk error${what}: ${detail} (HTTP ${res.status})`, res.status, body.error);
    }
  }

  /** Calls the API with the OAuth token. A rejected token is refreshed and retried once when possible. */
  private async request(
    method: string,
    endpoint: string,
    query: Record<string, string | number | boolean | undefined> = {},
    subject?: string,
  ): Promise<{ status: number; body: any }> {
    const url = new URL(endpoint.startsWith('http') ? endpoint : `${this.cfg.apiUrl}/v1/disk${endpoint}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const token = attempt === 0 ? await this.tokens.getAccessToken() : await this.tokens.refresh();
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers: { Authorization: `OAuth ${token}`, Accept: 'application/json' } });
      } catch (err) {
        throw new DiskError(`Could not reach Yandex Disk: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (res.status === 401 && attempt === 0 && this.tokens.canRefresh) continue;
      if (!res.ok) throw await this.error(res, subject);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    }
  }

  /** Waits for an asynchronous operation (202 + Link) to finish, up to the poll timeout. */
  private async settle(res: { status: number; body: any }, action: string): Promise<{ done: boolean; operation?: string }> {
    if (res.status !== 202 || !res.body?.href) return { done: true };
    const href: string = res.body.href;
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      const { body } = await this.request('GET', href);
      if (body?.status === 'success') return { done: true };
      if (body?.status === 'failed') throw new DiskError(`${action} failed on Yandex Disk.`);
      if (Date.now() > deadline) return { done: false, operation: href.split('/').pop() };
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  private resource(apiPath: string, extra: Record<string, string | number | undefined> = {}): Promise<Resource> {
    return this.request('GET', '/resources', { path: apiPath, fields: RESOURCE_FIELDS, ...extra }, apiPath).then((r) => r.body);
  }

  async info() {
    const { body } = await this.request('GET', '');
    return {
      user: body.user?.login ?? this.cfg.user,
      total_space: body.total_space,
      used_space: body.used_space,
      free_space: body.total_space - body.used_space,
      trash_size: body.trash_size,
      max_file_size: body.max_file_size,
      access: this.cfg.access,
      read_only: this.cfg.readOnly,
    };
  }

  async list(userPath: string, opts: { limit: number; offset: number; sort?: string }) {
    const apiPath = this.p(userPath);
    const fields = `${RESOURCE_FIELDS},_embedded.items.${RESOURCE_FIELDS.split(',').join(',_embedded.items.')},_embedded.total`;
    const { body } = await this.request('GET', '/resources', { path: apiPath, limit: opts.limit, offset: opts.offset, sort: opts.sort, fields }, apiPath);
    const r = body as Resource;
    if (r.type === 'file') return { ...summarize(r), note: 'This is a file, not a folder.' };
    const items = r._embedded?.items ?? [];
    return { path: r.path, total: r._embedded?.total, offset: opts.offset, items: items.map(summarize) };
  }

  async get(userPath: string) {
    const r = await this.resource(this.p(userPath), { limit: 0 });
    return { ...summarize(r), created: r.created, md5: r.md5, sha256: r.sha256, media_type: r.media_type };
  }

  /** Scans the flat file list (the API has no search) and keeps files whose name contains `name`. */
  async find(opts: { name?: string; media_type?: string; limit: number; scan_limit: number }) {
    const needle = opts.name?.toLowerCase();
    const found: ReturnType<typeof summarize>[] = [];
    let scanned = 0;
    let exhausted = false;
    while (!exhausted && found.length < opts.limit && scanned < opts.scan_limit) {
      const want = Math.min(1000, opts.scan_limit - scanned);
      const { body } = await this.request('GET', '/resources/files', {
        limit: want,
        offset: scanned,
        media_type: opts.media_type,
        fields: `items.${RESOURCE_FIELDS.split(',').join(',items.')}`,
      });
      const items: Resource[] = body?.items ?? [];
      scanned += items.length;
      exhausted = items.length < want;
      for (const it of items) {
        if (found.length >= opts.limit) break;
        if (!needle || it.name.toLowerCase().includes(needle)) found.push(summarize(it));
      }
    }
    const stoppedEarly = !exhausted && found.length < opts.limit;
    return {
      items: found,
      scanned,
      ...(stoppedEarly ? { note: `Scanned ${scanned} files without reaching the end. Raise scan_limit or narrow with media_type.` } : {}),
    };
  }

  async recent(opts: { limit: number; media_type?: string }) {
    const { body } = await this.request('GET', '/resources/last-uploaded', {
      limit: opts.limit,
      media_type: opts.media_type,
      fields: `items.${RESOURCE_FIELDS.split(',').join(',items.')}`,
    });
    return { items: ((body?.items ?? []) as Resource[]).map(summarize) };
  }

  private async downloadResponse(apiPath: string): Promise<Response> {
    const { body } = await this.request('GET', '/resources/download', { path: apiPath }, apiPath);
    const res = await this.fetchImpl((body as Link).href);
    if (!res.ok || !res.body) throw new DiskError(`Download failed (${apiPath}): HTTP ${res.status}`, res.status);
    return res;
  }

  /** Reads up to maxBytes of a file as text. */
  async read(userPath: string, maxBytes: number) {
    const apiPath = this.p(userPath);
    const meta = await this.resource(apiPath, { limit: 0 });
    if (meta.type === 'dir') throw new DiskError(`${meta.path} is a folder. Use list_folder.`);
    const res = await this.downloadResponse(apiPath);
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    const reader = res.body!.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (total + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.length;
    }
    const content = decodeText(Buffer.concat(chunks), truncated);
    return {
      path: meta.path,
      size: meta.size,
      modified: meta.modified,
      md5: meta.md5,
      truncated,
      ...(truncated ? { note: `Showing the first ${maxBytes} bytes. Raise max_bytes or use download_file.` } : {}),
      content,
    };
  }

  /** Creates the parent folders of apiPath, ignoring ones that already exist. */
  private async ensureParents(apiPath: string): Promise<void> {
    const { root, folders } = parentFolders(apiPath);
    for (const f of folders) {
      try {
        await this.request('PUT', '/resources', { path: `${root}${f}` }, `${root}${f}`);
      } catch (err) {
        if (!(err instanceof DiskError && err.status === 409)) throw err;
      }
    }
  }

  private async uploadBody(apiPath: string, body: NonNullable<RequestInit['body']>, overwrite: boolean, size?: number): Promise<void> {
    let link: Link;
    try {
      link = (await this.request('GET', '/resources/upload', { path: apiPath, overwrite }, apiPath)).body;
    } catch (err) {
      if (err instanceof DiskError && err.status === 409 && !overwrite) {
        throw new DiskError(`${apiPath} already exists. Set overwrite to replace it, or use edit_file to change it.`, 409, err.code);
      }
      throw err;
    }
    const headers: Record<string, string> = {};
    if (size !== undefined) headers['content-length'] = String(size);
    const res = await this.fetchImpl(link.href, { method: 'PUT', body, headers, duplex: 'half' } as RequestInit);
    if (res.status !== 201 && res.status !== 202 && !res.ok) {
      if (res.status === 413) throw new DiskError(`The file is too large for Yandex Disk.`, 413);
      if (res.status === 507) throw new DiskError(`Not enough space on Yandex Disk.`, 507);
      throw new DiskError(`Upload failed (${apiPath}): HTTP ${res.status}`, res.status);
    }
  }

  async write(userPath: string, content: string, opts: { overwrite: boolean; create_folders: boolean }) {
    const apiPath = this.p(userPath);
    if (opts.create_folders) await this.ensureParents(apiPath);
    const bytes = Buffer.from(content, 'utf8');
    await this.uploadBody(apiPath, bytes, opts.overwrite, bytes.length);
    return { path: apiPath, size: bytes.length, written: true };
  }

  /** Read-modify-write. Refuses to save if the file changed on Disk while it was being edited. */
  async edit(userPath: string, edits: TextEdit[]) {
    const apiPath = this.p(userPath);
    const before = await this.resource(apiPath, { limit: 0 });
    if (before.type === 'dir') throw new DiskError(`${before.path} is a folder.`);
    if ((before.size ?? 0) > MAX_EDIT_BYTES) {
      throw new DiskError(`${before.path} is larger than ${MAX_EDIT_BYTES / 1024 / 1024} MB, too big to edit in place.`);
    }
    const res = await this.downloadResponse(apiPath);
    const original = decodeText(new Uint8Array(await res.arrayBuffer()), false);
    const { text, replacements } = applyEdits(original, edits);
    const now = await this.resource(apiPath, { limit: 0 });
    if (before.md5 && now.md5 && now.md5 !== before.md5) {
      throw new DiskError(`${before.path} changed on Yandex Disk while it was being edited. Read it again and retry.`);
    }
    const bytes = Buffer.from(text, 'utf8');
    await this.uploadBody(apiPath, bytes, true, bytes.length);
    return { path: before.path, replacements, size: bytes.length };
  }

  async upload(localPath: string, userPath: string, opts: { overwrite: boolean; create_folders: boolean }) {
    const file = path.resolve(expandHome(localPath));
    const st = await stat(file).catch(() => undefined);
    if (!st?.isFile()) throw new DiskError(`Local file not found: ${file}`);
    let apiPath = this.p(userPath);
    if (userPath.trim().endsWith('/')) apiPath = `${apiPath.replace(/\/$/, '')}/${path.basename(file)}`;
    if (opts.create_folders) await this.ensureParents(apiPath);
    const body = Readable.toWeb(createReadStream(file)) as unknown as NonNullable<RequestInit['body']>;
    await this.uploadBody(apiPath, body, opts.overwrite, st.size);
    return { path: apiPath, size: st.size, uploaded_from: file };
  }

  /** Saves a file (or a folder, as a zip) to a local directory. Never overwrites local files. */
  async download(userPath: string, directory: string) {
    const apiPath = this.p(userPath);
    const meta = await this.resource(apiPath, { limit: 0 });
    const dir = path.resolve(expandHome(directory));
    await mkdir(dir, { recursive: true });
    const base = path.basename(meta.type === 'dir' ? `${meta.name || 'disk'}.zip` : meta.name);
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    let target = path.join(dir, base);
    for (let n = 1; await stat(target).then(() => true, () => false); n++) target = path.join(dir, `${stem} (${n})${ext}`);
    const res = await this.downloadResponse(apiPath);
    try {
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(target, { flags: 'wx' }));
    } catch (err) {
      await rm(target, { force: true });
      throw err;
    }
    const saved = await stat(target);
    return { path: target, size: saved.size, from: meta.path, ...(meta.type === 'dir' ? { note: 'Folders download as a zip archive.' } : {}) };
  }

  async createFolder(userPath: string, parents: boolean) {
    const apiPath = this.p(userPath);
    if (parents) await this.ensureParents(apiPath);
    try {
      await this.request('PUT', '/resources', { path: apiPath }, apiPath);
    } catch (err) {
      if (err instanceof DiskError && err.status === 409) {
        throw new DiskError(`${apiPath} already exists, or its parent folder doesn't (set parents to create it).`, 409, err.code);
      }
      throw err;
    }
    return { path: apiPath, created: true };
  }

  private async transfer(kind: 'copy' | 'move', from: string, to: string, overwrite: boolean) {
    const src = this.p(from);
    let dst = this.p(to);
    if (to.trim().endsWith('/')) dst = `${dst.replace(/\/$/, '')}/${src.split('/').pop()}`;
    const res = await this.request('POST', `/resources/${kind}`, { from: src, path: dst, overwrite }, `${src} → ${dst}`);
    const { done, operation } = await this.settle(res, kind === 'copy' ? 'Copy' : 'Move');
    return { from: src, to: dst, status: done ? 'done' : 'in progress', ...(operation ? { operation } : {}) };
  }

  copy(from: string, to: string, overwrite: boolean) {
    return this.transfer('copy', from, to, overwrite);
  }

  move(from: string, to: string, overwrite: boolean) {
    return this.transfer('move', from, to, overwrite);
  }

  async remove(userPath: string, permanently: boolean) {
    const apiPath = this.p(userPath);
    const res = await this.request('DELETE', '/resources', { path: apiPath, permanently }, apiPath);
    const { done, operation } = await this.settle(res, 'Delete');
    return {
      path: apiPath,
      status: done ? 'done' : 'in progress',
      ...(operation ? { operation } : {}),
      where: permanently ? 'deleted permanently' : 'moved to the Disk trash',
    };
  }

  async publish(userPath: string) {
    const apiPath = this.p(userPath);
    await this.request('PUT', '/resources/publish', { path: apiPath }, apiPath);
    const r = await this.resource(apiPath, { limit: 0 });
    return { path: r.path, public_url: r.public_url };
  }

  async unpublish(userPath: string) {
    const apiPath = this.p(userPath);
    await this.request('PUT', '/resources/unpublish', { path: apiPath }, apiPath);
    return { path: apiPath, public: false };
  }

  async listTrash(opts: { limit: number; offset: number }) {
    const { body } = await this.request('GET', '/trash/resources', { path: 'trash:/', limit: opts.limit, offset: opts.offset });
    const items: Resource[] = body?._embedded?.items ?? [];
    return {
      total: body?._embedded?.total,
      items: items.map((r) => ({ ...summarize(r), original_path: r.origin_path, deleted: r.deleted })),
    };
  }

  async restore(trashPath: string, opts: { name?: string; overwrite: boolean }) {
    const p = trashPath.startsWith('trash:') ? trashPath : `trash:/${trashPath.replace(/^\/+/, '')}`;
    const res = await this.request('PUT', '/trash/resources/restore', { path: p, name: opts.name, overwrite: opts.overwrite }, p);
    const { done, operation } = await this.settle(res, 'Restore');
    return { restored: p, status: done ? 'done' : 'in progress', ...(operation ? { operation } : {}) };
  }
}
