import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DiskError, DiskService, applyEdits, decodeText, parentFolders, toApiPath } from '../src/disk.js';

const API = 'https://disk.test';

interface Node {
  type: 'dir' | 'file';
  data?: Buffer;
  modified: string;
  public_url?: string;
}

/** An in-memory Yandex Disk speaking enough of the REST API for the service. */
class FakeDisk {
  nodes = new Map<string, Node>([['disk:/', { type: 'dir', modified: '2026-01-01T00:00:00+00:00' }]]);
  trash = new Map<string, Node & { origin: string }>();
  ops = new Map<string, string>();
  uploads = new Map<string, { path: string }>();
  requests: string[] = [];
  /** Respond 401 to this many API calls (simulates a rejected token). */
  reject = 0;
  /** Make move return 202 and finish after this many polls. */
  asyncMovePolls = 0;
  tick = 0;

  put(p: string, data: string) {
    this.nodes.set(p, { type: 'file', data: Buffer.from(data), modified: this.stamp() });
  }

  stamp() {
    return new Date(Date.UTC(2026, 0, 1, 0, 0, ++this.tick)).toISOString();
  }

  meta(p: string) {
    const n = this.nodes.get(p)!;
    const name = p === 'disk:/' ? 'disk' : p.split('/').pop()!;
    return {
      name,
      path: p,
      type: n.type,
      modified: n.modified,
      ...(n.type === 'file'
        ? { size: n.data!.length, md5: createHash('md5').update(n.data!).digest('hex'), mime_type: 'text/plain' }
        : {}),
      ...(n.public_url ? { public_url: n.public_url } : {}),
    };
  }

  children(dir: string) {
    const prefix = dir === 'disk:/' ? 'disk:/' : `${dir}/`;
    return [...this.nodes.keys()].filter((k) => k !== dir && k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).sort();
  }

  parentOf(p: string) {
    const i = p.lastIndexOf('/');
    return i <= 'disk:'.length ? 'disk:/' : p.slice(0, i);
  }

  fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const json = (status: number, body?: unknown) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const err = (status: number, error: string, description: string) => json(status, { error, description, message: description });

    if (url.host === 'upload.test') {
      const up = this.uploads.get(url.pathname)!;
      const data = Buffer.from(await new Response(init.body as BodyInit).arrayBuffer());
      this.nodes.set(up.path, { type: 'file', data, modified: this.stamp() });
      return new Response(null, { status: 201 });
    }
    if (url.host === 'download.test') {
      const n = this.nodes.get(decodeURIComponent(url.pathname.slice(1)))!;
      return new Response(n.data ?? Buffer.from('PK-zip'), { status: 200 });
    }

    const auth = (init.headers as Record<string, string>)?.Authorization;
    expect(auth).toMatch(/^OAuth /);
    this.requests.push(`${method} ${url.pathname}`);
    if (this.reject > 0) {
      this.reject--;
      return err(401, 'UnauthorizedError', 'Unauthorized');
    }
    const route = url.pathname.replace(/^\/v1\/disk/, '');
    const q = (k: string) => url.searchParams.get(k) ?? undefined;
    const p = q('path');

    if (route === '' || route === '/') return json(200, { total_space: 1000, used_space: 250, trash_size: 5, max_file_size: 100, user: { login: 'me' } });
    if (route.startsWith('/operations/')) {
      const left = Number(this.ops.get(route.split('/').pop()!));
      this.ops.set(route.split('/').pop()!, String(left - 1));
      return json(200, { status: left <= 1 ? 'success' : 'in-progress' });
    }
    if (route === '/resources' && method === 'GET') {
      if (!this.nodes.has(p!)) return err(404, 'DiskNotFoundError', 'Resource not found.');
      const m = this.meta(p!);
      if (m.type === 'dir') {
        const kids = this.children(p!);
        const offset = Number(q('offset') ?? 0);
        const limit = Number(q('limit') ?? 20);
        return json(200, { ...m, _embedded: { items: kids.slice(offset, offset + limit).map((k) => this.meta(k)), total: kids.length } });
      }
      return json(200, m);
    }
    if (route === '/resources' && method === 'PUT') {
      if (this.nodes.has(p!)) return err(409, 'DiskPathPointsToExistentDirectoryError', 'Already exists.');
      if (!this.nodes.has(this.parentOf(p!))) return err(409, 'DiskPathDoesntExistsError', 'Parent missing.');
      this.nodes.set(p!, { type: 'dir', modified: this.stamp() });
      return json(201, { href: `${API}/v1/disk/resources?path=${p}` });
    }
    if (route === '/resources' && method === 'DELETE') {
      if (!this.nodes.has(p!)) return err(404, 'DiskNotFoundError', 'Resource not found.');
      for (const k of [...this.nodes.keys()]) {
        if (k === p || k.startsWith(`${p}/`)) {
          if (q('permanently') !== 'true') this.trash.set(`trash:/${k.split('/').pop()}`, { ...this.nodes.get(k)!, origin: k });
          this.nodes.delete(k);
        }
      }
      return new Response(null, { status: 204 });
    }
    if (route === '/resources/upload') {
      if (this.nodes.has(p!) && q('overwrite') !== 'true') return err(409, 'DiskResourceAlreadyExistsError', 'Exists.');
      if (!this.nodes.has(this.parentOf(p!))) return err(409, 'DiskPathDoesntExistsError', 'Parent missing.');
      const id = `/u${this.uploads.size}`;
      this.uploads.set(id, { path: p! });
      return json(200, { href: `https://upload.test${id}`, method: 'PUT' });
    }
    if (route === '/resources/download') {
      if (!this.nodes.has(p!)) return err(404, 'DiskNotFoundError', 'Resource not found.');
      return json(200, { href: `https://download.test/${encodeURIComponent(p!)}`, method: 'GET' });
    }
    if (route === '/resources/copy' || route === '/resources/move') {
      const from = q('from')!;
      if (!this.nodes.has(from)) return err(404, 'DiskNotFoundError', 'Resource not found.');
      if (this.nodes.has(p!) && q('overwrite') !== 'true') return err(409, 'DiskResourceAlreadyExistsError', 'Exists.');
      for (const [k, v] of [...this.nodes]) {
        if (k === from || k.startsWith(`${from}/`)) {
          this.nodes.set(p + k.slice(from.length), { ...v });
          if (route === '/resources/move') this.nodes.delete(k);
        }
      }
      if (route === '/resources/move' && this.asyncMovePolls) {
        this.ops.set('op1', String(this.asyncMovePolls));
        return json(202, { href: `${API}/v1/disk/operations/op1`, method: 'GET' });
      }
      return json(201, { href: `${API}/v1/disk/resources?path=${p}` });
    }
    if (route === '/resources/publish') {
      this.nodes.get(p!)!.public_url = 'https://yadi.sk/d/abc';
      return json(200, { href: '' });
    }
    if (route === '/resources/unpublish') {
      delete this.nodes.get(p!)!.public_url;
      return json(200, { href: '' });
    }
    if (route === '/resources/files') {
      const files = [...this.nodes.keys()].filter((k) => this.nodes.get(k)!.type === 'file').sort();
      const offset = Number(q('offset') ?? 0);
      return json(200, { items: files.slice(offset, offset + Number(q('limit'))).map((k) => this.meta(k)) });
    }
    if (route === '/resources/last-uploaded') {
      const files = [...this.nodes.keys()].filter((k) => this.nodes.get(k)!.type === 'file');
      files.sort((a, b) => this.nodes.get(b)!.modified.localeCompare(this.nodes.get(a)!.modified));
      return json(200, { items: files.slice(0, Number(q('limit'))).map((k) => this.meta(k)) });
    }
    if (route === '/trash/resources') {
      const items = [...this.trash].map(([k, v]) => ({ name: k.slice(7), path: k, type: v.type, origin_path: v.origin, deleted: v.modified }));
      return json(200, { path: 'trash:/', _embedded: { items, total: items.length } });
    }
    if (route === '/trash/resources/restore') {
      const t = this.trash.get(p!);
      if (!t) return err(404, 'DiskNotFoundError', 'Not in trash.');
      const { origin, ...node } = t;
      this.nodes.set(q('name') ? `${this.parentOf(origin)}/${q('name')}` : origin, node);
      this.trash.delete(p!);
      return json(201, { href: '' });
    }
    return err(400, 'BadRequest', `unhandled ${method} ${route}`);
  }) as typeof fetch;
}

let disk: FakeDisk;
let refreshes: number;
let svc: (env?: Record<string, string>, canRefresh?: boolean) => DiskService;

beforeEach(() => {
  disk = new FakeDisk();
  refreshes = 0;
  svc = (env = {}, canRefresh = false) =>
    new DiskService(loadConfig({ YANDEX_USER: 'me@ya.ru', YANDEX_DISK_API_URL: API, ...env }), {
      fetchImpl: disk.fetch,
      pollIntervalMs: 1,
      tokens: {
        canRefresh,
        getAccessToken: async () => 'AT',
        refresh: async () => {
          refreshes++;
          return 'AT2';
        },
      },
    });
});

describe('paths', () => {
  it('maps user paths to the Disk root or the app folder', () => {
    expect(toApiPath('/Documents/a.txt', 'full')).toBe('disk:/Documents/a.txt');
    expect(toApiPath('Documents/', 'full')).toBe('disk:/Documents');
    expect(toApiPath('/', 'full')).toBe('disk:/');
    expect(toApiPath('/notes.md', 'app-folder')).toBe('app:/notes.md');
    expect(toApiPath('disk:/x', 'app-folder')).toBe('disk:/x');
    expect(toApiPath('trash:/x', 'full')).toBe('trash:/x');
  });
  it('lists the parent folders to create', () => {
    expect(parentFolders('disk:/a/b/c.txt')).toEqual({ root: 'disk:', folders: ['/a', '/a/b'] });
    expect(parentFolders('app:/c.txt')).toEqual({ root: 'app:', folders: [] });
  });
});

describe('text helpers', () => {
  it('applies exact edits and refuses ambiguous or missing text', () => {
    expect(applyEdits('a b a', [{ old_text: 'b', new_text: 'B' }])).toEqual({ text: 'a B a', replacements: 1 });
    expect(applyEdits('a b a', [{ old_text: 'a', new_text: 'x', replace_all: true }])).toEqual({ text: 'x b x', replacements: 2 });
    expect(() => applyEdits('a b a', [{ old_text: 'a', new_text: 'x' }])).toThrow(/occurs 2 times/);
    expect(() => applyEdits('a', [{ old_text: 'z', new_text: 'x' }])).toThrow(/not found/);
    expect(applyEdits('$1', [{ old_text: '$1', new_text: '$&$&' }]).text).toBe('$&$&');
  });
  it('rejects binary content and tolerates a cut-off character', () => {
    expect(() => decodeText(new Uint8Array([0x25, 0x50, 0x00]), false)).toThrow(/binary/);
    expect(() => decodeText(new Uint8Array([0xff, 0xfe]), false)).toThrow(/not UTF-8/);
    const cut = Buffer.from('привет').subarray(0, 3);
    expect(decodeText(cut, true)).toBe('п');
  });
});

describe('DiskService', () => {
  it('reports space and access mode', async () => {
    expect(await svc().info()).toMatchObject({ user: 'me', total_space: 1000, free_space: 750, access: 'full' });
  });

  it('writes, reads, edits and lists a text file, creating folders', async () => {
    const s = svc();
    await s.write('/Notes/2026/todo.md', '# Todo\n- milk\n', { overwrite: false, create_folders: true });
    expect(disk.nodes.get('disk:/Notes')?.type).toBe('dir');
    expect((await s.read('/Notes/2026/todo.md', 1000)).content).toBe('# Todo\n- milk\n');
    await expect(s.write('/Notes/2026/todo.md', 'x', { overwrite: false, create_folders: true })).rejects.toThrow(/already exists.*edit_file/);
    const edited = await s.edit('/Notes/2026/todo.md', [{ old_text: '- milk', new_text: '- milk\n- eggs' }]);
    expect(edited.replacements).toBe(1);
    expect(disk.nodes.get('disk:/Notes/2026/todo.md')!.data!.toString()).toBe('# Todo\n- milk\n- eggs\n');
    const listing = await s.list('/Notes/2026', { limit: 10, offset: 0 });
    expect(listing).toMatchObject({ total: 1, items: [{ name: 'todo.md', type: 'file', size: 21 }] });
  });

  it('truncates long reads and refuses folders', async () => {
    disk.put('disk:/big.txt', 'abcdefghij');
    const r = await svc().read('/big.txt', 4);
    expect(r).toMatchObject({ content: 'abcd', truncated: true });
    await expect(svc().read('/', 4)).rejects.toThrow(/is a folder/);
  });

  it('does not save an edit if the file changed meanwhile', async () => {
    disk.put('disk:/a.txt', 'one');
    const realFetch = disk.fetch;
    let downloads = 0;
    disk.fetch = (async (input: string | URL, init?: RequestInit) => {
      const res = await realFetch(input, init);
      if (String(input).startsWith('https://download.test') && ++downloads === 1) disk.put('disk:/a.txt', 'two');
      return res;
    }) as typeof fetch;
    await expect(svc().edit('/a.txt', [{ old_text: 'one', new_text: 'ONE' }])).rejects.toThrow(/changed on Yandex Disk/);
    expect(disk.nodes.get('disk:/a.txt')!.data!.toString()).toBe('two');
  });

  it('uploads and downloads local files without overwriting local copies', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ydisk-'));
    const local = path.join(dir, 'report.csv');
    await writeFile(local, 'a,b\n1,2\n');
    const s = svc();
    const up = await s.upload(local, '/Reports/', { overwrite: false, create_folders: true });
    expect(up.path).toBe('disk:/Reports/report.csv');
    const first = await s.download('/Reports/report.csv', dir);
    expect(first.path).toBe(path.join(dir, 'report (1).csv'));
    expect(await readFile(first.path, 'utf8')).toBe('a,b\n1,2\n');
    const zip = await s.download('/Reports', dir);
    expect(zip.path).toBe(path.join(dir, 'Reports.zip'));
  });

  it('copies, moves (waiting for async operations), deletes to trash and restores', async () => {
    disk.put('disk:/a.txt', 'x');
    const s = svc();
    await s.createFolder('/Archive', false);
    expect(await s.copy('/a.txt', '/Archive/', false)).toMatchObject({ to: 'disk:/Archive/a.txt', status: 'done' });
    disk.asyncMovePolls = 2;
    expect(await s.move('/a.txt', '/b.txt', false)).toMatchObject({ status: 'done' });
    expect(disk.requests.filter((r) => r.includes('/operations/'))).toHaveLength(2);
    expect(disk.nodes.has('disk:/b.txt')).toBe(true);
    expect(await s.remove('/b.txt', false)).toMatchObject({ where: 'moved to the Disk trash' });
    expect((await s.listTrash({ limit: 10, offset: 0 })).items[0]).toMatchObject({ path: 'trash:/b.txt', original_path: 'disk:/b.txt' });
    await s.restore('trash:/b.txt', { overwrite: false });
    expect(disk.nodes.has('disk:/b.txt')).toBe(true);
    await expect(s.createFolder('/Archive', false)).rejects.toThrow(/already exists/);
  });

  it('reports a long-running operation instead of waiting forever', async () => {
    disk.put('disk:/a.txt', 'x');
    disk.asyncMovePolls = 1000;
    const s = new DiskService(loadConfig({ YANDEX_USER: 'me@ya.ru', YANDEX_DISK_API_URL: API }), {
      fetchImpl: disk.fetch,
      pollIntervalMs: 1,
      pollTimeoutMs: 20,
      tokens: { canRefresh: false, getAccessToken: async () => 'AT', refresh: async () => 'AT' },
    });
    expect(await s.move('/a.txt', '/b.txt', false)).toMatchObject({ status: 'in progress', operation: 'op1' });
  });

  it('shares and unshares by link', async () => {
    disk.put('disk:/a.txt', 'x');
    expect(await svc().publish('/a.txt')).toEqual({ path: 'disk:/a.txt', public_url: 'https://yadi.sk/d/abc' });
    await svc().unpublish('/a.txt');
    expect(disk.nodes.get('disk:/a.txt')!.public_url).toBeUndefined();
  });

  it('finds files by name across pages and lists recent uploads', async () => {
    for (let i = 0; i < 2500; i++) disk.put(`disk:/f${String(i).padStart(4, '0')}.txt`, '');
    disk.put('disk:/x Taxes 2025.pdf', ''); // sorts after the f0000… files
    const s = svc();
    expect(await s.find({ name: 'taxes', limit: 10, scan_limit: 20000 })).toMatchObject({ items: [{ name: 'x Taxes 2025.pdf' }], scanned: 2501 });
    const partial = await s.find({ name: 'taxes', limit: 10, scan_limit: 1500 });
    expect(partial.items).toHaveLength(0);
    expect(partial.note).toMatch(/Raise scan_limit/);
    expect((await s.recent({ limit: 1 })).items[0]!.name).toBe('x Taxes 2025.pdf');
  });

  it('explains missing paths and rejected logins', async () => {
    await expect(svc().get('/nope')).rejects.toThrow(/Not found \(disk:\/nope\)/);
    disk.reject = 1;
    await expect(svc().info()).rejects.toThrow(/npx yandex-disk-mcp login/);
    disk.reject = 1;
    expect(await svc({}, true).info()).toMatchObject({ total_space: 1000 });
    expect(refreshes).toBe(1);
  });

  it('works inside the app folder', async () => {
    const s = svc({ YANDEX_DISK_ACCESS: 'app-folder' });
    await expect(s.get('/x')).rejects.toBeInstanceOf(DiskError);
    expect(disk.requests.at(-1)).toBe('GET /v1/disk/resources');
  });
});

describe('config', () => {
  it('asks only for what the mode needs', () => {
    const scope = (env: Record<string, string>) => loadConfig({ YANDEX_USER: 'a@x', ...env }).oauth.scope;
    expect(scope({})).toBe('cloud_api:disk.read cloud_api:disk.write cloud_api:disk.info');
    expect(scope({ YANDEX_DISK_READ_ONLY: 'true' })).toBe('cloud_api:disk.read cloud_api:disk.info');
    expect(scope({ YANDEX_DISK_ACCESS: 'app-folder' })).toBe('cloud_api:disk.app_folder cloud_api:disk.info');
  });
  it('keeps app-folder logins apart from full-access ones', () => {
    const file = (env: Record<string, string>) => loadConfig({ YANDEX_USER: 'a@x', XDG_CONFIG_HOME: '/c', ...env }).oauth.tokenFile;
    expect(file({})).toMatch(/-disk\.json$/);
    expect(file({ YANDEX_DISK_ACCESS: 'app-folder' })).toMatch(/-disk-app-folder\.json$/);
  });
  it('rejects app passwords and unknown modes', () => {
    expect(() => loadConfig({})).toThrow(/YANDEX_USER/);
    expect(() => loadConfig({ YANDEX_USER: 'a@x', YANDEX_AUTH: 'password' })).toThrow(/only supports OAuth/);
    expect(() => loadConfig({ YANDEX_USER: 'a@x', YANDEX_DISK_ACCESS: 'everything' })).toThrow(/YANDEX_DISK_ACCESS/);
  });
});
