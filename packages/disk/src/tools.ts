import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ConfigError, loadConfig } from './config.js';
import { DiskService, MAX_EDIT_BYTES } from './disk.js';

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
}

const diskPath = z
  .string()
  .min(1)
  .describe('Path on Disk, e.g. "/Documents/notes.md". Paths returned by other tools ("disk:/…") work too');
const mediaType = z
  .enum(['audio', 'backup', 'book', 'compressed', 'data', 'development', 'diskimage', 'document', 'encoded', 'executable', 'flash', 'font', 'image', 'settings', 'spreadsheet', 'text', 'unknown', 'video', 'web'])
  .optional()
  .describe('Only files of this kind');
const overwrite = z.boolean().default(false).describe('Replace an existing file at the destination');
const createFolders = z.boolean().default(true).describe('Create missing parent folders');

export function registerDiskTools(server: McpServer, env: Record<string, string | undefined> = process.env, service?: DiskService) {
  // Config is resolved lazily so the server still starts (and reports a clear error) without a login.
  let disk = service;
  const run = async (fn: (s: DiskService) => Promise<unknown>) => {
    try {
      disk ??= new DiskService(loadConfig(env));
      return ok(await fn(disk));
    } catch (err) {
      return fail(err);
    }
  };

  let readOnly = false;
  try {
    readOnly = loadConfig(env).readOnly;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
  }

  const read = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool(
    'disk_info',
    {
      title: 'Disk info',
      description: 'Space used and free on Yandex Disk (bytes), and whether this server has full or app-folder access.',
      annotations: read,
    },
    () => run((s) => s.info()),
  );

  server.registerTool(
    'list_folder',
    {
      title: 'List folder',
      description: 'List the files and folders in a Disk folder. "/" is the root.',
      inputSchema: {
        path: diskPath.default('/'),
        limit: z.number().int().min(1).max(1000).default(100),
        offset: z.number().int().min(0).default(0),
        sort: z.enum(['name', '-name', 'modified', '-modified', 'size', '-size', 'created', '-created']).optional(),
      },
      annotations: read,
    },
    ({ path, ...opts }) => run((s) => s.list(path, opts)),
  );

  server.registerTool(
    'get_info',
    {
      title: 'Get file info',
      description: 'Details of one file or folder: size, dates, type, checksums and public link if shared.',
      inputSchema: { path: diskPath },
      annotations: read,
    },
    ({ path }) => run((s) => s.get(path)),
  );

  server.registerTool(
    'find_files',
    {
      title: 'Find files',
      description:
        'Find files whose name contains some text, across the whole Disk. Yandex has no search API, so this scans the ' +
        'file list (up to scan_limit files). Filtering by media_type makes it faster. File contents are not searched.',
      inputSchema: {
        name: z.string().optional().describe('Case-insensitive text the file name contains'),
        media_type: mediaType,
        limit: z.number().int().min(1).max(500).default(50),
        scan_limit: z.number().int().min(1).max(100000).default(20000),
      },
      annotations: read,
    },
    (args) => run((s) => s.find(args)),
  );

  server.registerTool(
    'recent_files',
    {
      title: 'Recent files',
      description: 'The most recently uploaded files, newest first.',
      inputSchema: { limit: z.number().int().min(1).max(200).default(20), media_type: mediaType },
      annotations: read,
    },
    (args) => run((s) => s.recent(args)),
  );

  server.registerTool(
    'read_file',
    {
      title: 'Read file',
      description: 'Read a text file (UTF-8) from Disk. Binary files, such as PDFs, images and Office files, need download_file.',
      inputSchema: {
        path: diskPath,
        max_bytes: z.number().int().min(1).max(MAX_EDIT_BYTES).default(1_000_000).describe('Read at most this many bytes'),
      },
      annotations: read,
    },
    ({ path, max_bytes }) => run((s) => s.read(path, max_bytes)),
  );

  server.registerTool(
    'download_file',
    {
      title: 'Download file',
      description:
        'Save a file from Disk to a local directory on this computer (folders arrive as a zip). Never overwrites local files.',
      inputSchema: { path: diskPath, directory: z.string().default('~/Downloads') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ path, directory }) => run((s) => s.download(path, directory)),
  );

  server.registerTool(
    'list_trash',
    {
      title: 'List trash',
      description: 'Files and folders in the Disk trash, with where they were deleted from.',
      inputSchema: { limit: z.number().int().min(1).max(1000).default(100), offset: z.number().int().min(0).default(0) },
      annotations: read,
    },
    (args) => run((s) => s.listTrash(args)),
  );

  if (readOnly) return;

  server.registerTool(
    'write_file',
    {
      title: 'Write file',
      description:
        'Create a text file on Disk with the given content. Fails if the file exists unless overwrite is set. ' +
        'To change part of an existing file, use edit_file.',
      inputSchema: { path: diskPath, content: z.string(), overwrite, create_folders: createFolders },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ path, content, ...opts }) => run((s) => s.write(path, content, opts)),
  );

  server.registerTool(
    'edit_file',
    {
      title: 'Edit file',
      description:
        'Change a text file on Disk by replacing exact text. Each old_text must appear exactly once (or set replace_all). ' +
        'Edits apply in order and are saved together; nothing is saved if any edit fails or the file changed meanwhile.',
      inputSchema: {
        path: diskPath,
        edits: z
          .array(
            z.object({
              old_text: z.string().min(1).describe('Exact text to replace, copied from read_file'),
              new_text: z.string().describe('Replacement text (empty deletes)'),
              replace_all: z.boolean().optional(),
            }),
          )
          .min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ path, edits }) => run((s) => s.edit(path, edits)),
  );

  server.registerTool(
    'upload_file',
    {
      title: 'Upload file',
      description: 'Upload a local file to Disk. A destination ending in "/" keeps the local file name.',
      inputSchema: { local_path: z.string().min(1), path: diskPath, overwrite, create_folders: createFolders },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ local_path, path, ...opts }) => run((s) => s.upload(local_path, path, opts)),
  );

  server.registerTool(
    'create_folder',
    {
      title: 'Create folder',
      description: 'Create a folder on Disk.',
      inputSchema: { path: diskPath, parents: z.boolean().default(true).describe('Create missing parent folders') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ path, parents }) => run((s) => s.createFolder(path, parents)),
  );

  const transferShape = {
    from: diskPath.describe('File or folder to copy or move'),
    to: diskPath.describe('New path. Ending it in "/" keeps the name inside that folder'),
    overwrite,
  };

  server.registerTool(
    'copy',
    {
      title: 'Copy',
      description: 'Copy a file or folder on Disk.',
      inputSchema: transferShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ from, to, overwrite }) => run((s) => s.copy(from, to, overwrite)),
  );

  server.registerTool(
    'move',
    {
      title: 'Move or rename',
      description: 'Move or rename a file or folder on Disk.',
      inputSchema: transferShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ from, to, overwrite }) => run((s) => s.move(from, to, overwrite)),
  );

  server.registerTool(
    'delete',
    {
      title: 'Delete',
      description: 'Delete a file or folder. It goes to the Disk trash (restorable with restore_from_trash) unless permanently is set.',
      inputSchema: { path: diskPath, permanently: z.boolean().default(false) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ path, permanently }) => run((s) => s.remove(path, permanently)),
  );

  server.registerTool(
    'restore_from_trash',
    {
      title: 'Restore from trash',
      description: 'Restore an item from the Disk trash to where it was deleted from.',
      inputSchema: {
        path: z.string().min(1).describe('Trash path from list_trash, e.g. "trash:/notes.md"'),
        name: z.string().optional().describe('Restore under a new name'),
        overwrite,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ path, name, overwrite }) => run((s) => s.restore(path, { name, overwrite })),
  );

  server.registerTool(
    'publish',
    {
      title: 'Share by link',
      description: 'Make a file or folder public and return its link. Anyone with the link can view and download it.',
      inputSchema: { path: diskPath },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ path }) => run((s) => s.publish(path)),
  );

  server.registerTool(
    'unpublish',
    {
      title: 'Stop sharing',
      description: 'Remove the public link from a file or folder.',
      inputSchema: { path: diskPath },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ path }) => run((s) => s.unpublish(path)),
  );
}
