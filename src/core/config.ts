import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { mkdir, lstat, readdir, access, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { TaskError } from '../types.js';

export type ConfigKey = 'store' | 'root';
type Settings = Partial<Record<ConfigKey, string>>;
type Source = 'argument' | 'environment' | 'config' | 'default';
export interface Configuration {
  file: string;
  values: Record<ConfigKey, string>;
  sources: Record<ConfigKey, Source>;
}

const MAX_CONFIG = 64 * 1024;
const anchor = () => join(homedir(), '.taskmd');
export const configPath = () => join(anchor(), 'config.json');

export function configKey(key: string): ConfigKey {
  if (key !== 'store' && key !== 'root') {
    throw new TaskError('invalid_config_key', `Unknown configuration key: ${key}`, 'Only store and root can be configured.');
  }
  return key;
}

export function absolutePath(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TaskError('invalid_config_path', 'Expected a nonempty directory path.');
  }
  if (/^~[^/\\]/.test(value)) throw new TaskError('invalid_config_path', '~user paths are not supported.', 'Use an absolute path or ~/path.');
  return resolve(value === '~' ? homedir() : /^~[/\\]/.test(value) ? join(homedir(), value.slice(2)) : value);
}

function readSettings(): Settings {
  let fd: number;
  try { fd = openSync(configPath(), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_CONFIG) throw new Error('Expected a regular configuration file of at most 64 KiB.');
    const bytes = Buffer.alloc(MAX_CONFIG + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_CONFIG) throw new Error('Configuration exceeds 64 KiB.');
    const settings: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Expected a JSON object.');
    const result: Settings = {};
    for (const [key, value] of Object.entries(settings)) {
      configKey(key);
      if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !isAbsolute(value)) {
        throw new Error(`${key} must be an absolute directory path.`);
      }
      result[key as ConfigKey] = resolve(value);
    }
    return result;
  } catch (error) {
    throw new TaskError('invalid_config', `Cannot read ${configPath()}: ${(error as Error).message}`, 'Repair the local configuration file; it supports only store and root.');
  } finally { closeSync(fd); }
}

function resolveSettings(settings: Settings, store?: string): Configuration {
  const root = settings.root ?? anchor();
  const environment = process.env.TASKMD_STORE;
  const chosenStore = store ?? (environment?.trim() ? environment : undefined) ?? settings.store;
  return {
    file: configPath(),
    values: { root, store: chosenStore === undefined ? join(root, 'store') : absolutePath(chosenStore) },
    sources: {
      root: settings.root === undefined ? 'default' : 'config',
      store: store !== undefined ? 'argument' : environment?.trim() ? 'environment' : settings.store !== undefined ? 'config' : 'default',
    },
  };
}

export function resolveConfiguration(store?: string): Configuration {
  return resolveSettings(readSettings(), store);
}

export function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

/** A fixed discovery lock also fences root changes against in-flight Store operations. */
export async function withConfigurationLock<T>(operation: (assertHeld: () => void) => Promise<T>): Promise<T> {
  await mkdir(anchor(), { recursive: true, mode: 0o700 });
  const info = await lstat(anchor());
  if (!info.isDirectory() || info.isSymbolicLink()) throw new TaskError('invalid_config_path', 'The taskmd configuration directory must be a regular directory.');
  let compromised: Error | undefined;
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(anchor(), {
      realpath: false, lockfilePath: join(anchor(), 'config.lock'), stale: 30_000, update: 5_000,
      retries: { retries: 50, factor: 1, minTimeout: 100, maxTimeout: 100 },
      onCompromised: error => { compromised = error; },
    });
  } catch (error) {
    throw new TaskError('config_busy', `Cannot lock taskmd configuration: ${(error as Error).message}`, 'Wait for the other taskmd operation and retry.');
  }
  const assertHeld = () => {
    if (compromised) throw new TaskError('lock_lost', compromised.message, 'Retry after other taskmd operations have stopped.');
  };
  try { return await operation(assertHeld); }
  finally { await release(); }
}

async function ensureNoPendingTransactions(root: string): Promise<void> {
  const local = join(root, 'local');
  let entries;
  try { entries = await readdir(local, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const directory = join(local, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new TaskError('invalid_local_data', `Not a regular local state directory: ${directory}`);
    try { await access(join(directory, 'pending.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    throw new TaskError('pending_transaction', `Cannot change root while a transaction needs recovery in ${directory}.`, 'Run a command against that task store using the current root to recover it first.');
  }
}

async function saveSettings(settings: Settings, assertHeld: () => void): Promise<void> {
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_CONFIG) throw new TaskError('config_too_large', 'Configuration exceeds 64 KiB.', 'Use shorter directory paths.');
  const temporary = join(dirname(configPath()), `.config-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    assertHeld();
    await rename(temporary, configPath());
    if (process.platform !== 'win32') {
      const directory = await open(dirname(configPath()), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** Changes selection only: existing task files and local state are never moved or overwritten. */
export async function configure(key: ConfigKey, value?: string, storeOverride?: string): Promise<Configuration> {
  return withConfigurationLock(async assertHeld => {
    const settings = readSettings();
    const previousRoot = settings.root ?? anchor();
    if (value === undefined) delete settings[key];
    else settings[key] = absolutePath(value);
    const configuration = resolveSettings(settings, storeOverride);
    // Reject putting private state/configuration inside the shared task store.
    // Store.prepare repeats this check after resolving symlinks.
    const persisted = resolveSettings(settings);
    const selectedStore = settings.store ?? join(configuration.values.root, 'store');
    for (const cloud of [selectedStore, persisted.values.store, configuration.values.store]) {
      if (within(cloud, configuration.values.root) || within(cloud, anchor())
        || within(join(configuration.values.root, 'local'), cloud)) {
        throw new TaskError('overlapping_paths', 'Task storage must be separate from local state and configuration.', 'Use a cloud folder for store and a local folder for root.');
      }
    }
    if (previousRoot !== configuration.values.root) await ensureNoPendingTransactions(previousRoot);
    assertHeld();
    await saveSettings(settings, assertHeld);
    return configuration;
  });
}
