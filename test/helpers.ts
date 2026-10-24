import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/taskmd.mjs', import.meta.url));

/** One throwaway HOME + store pair per test; nothing outside it is touched. */
export interface Sandbox {
  base: string;
  home: string;
  store: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a test body against a temporary HOME and task store.
 *
 * The store and the local root are selected through TASKMD_STORE plus HOME, so
 * `~/.taskmd` resolves inside the sandbox and the real one is never read or
 * written. Store instances must be constructed inside `run`, because the
 * configuration is resolved when a Store is created.
 */
export async function withSandbox(run: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'taskmd-test-'));
  const home = join(base, 'home');
  const store = join(base, 'store');
  await mkdir(home, { recursive: true });
  const saved = {
    HOME: process.env.HOME,
    TASKMD_STORE: process.env.TASKMD_STORE,
    DSH_SESSION_ID: process.env.DSH_SESSION_ID,
  };
  process.env.HOME = home;
  process.env.TASKMD_STORE = store;
  delete process.env.DSH_SESSION_ID;
  try {
    await run({ base, home, store });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(base, { recursive: true, force: true });
  }
}

/** Runs `node bin/taskmd.mjs` in the sandbox, never inheriting a real session ID. */
export function runCli(
  sandbox: Sandbox, args: string[], extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: sandbox.home, TASKMD_STORE: sandbox.store };
  delete env.DSH_SESSION_ID;
  Object.assign(env, extraEnv);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [bin, ...args], { env, cwd: sandbox.base });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', rejectRun);
    child.once('close', (code) => resolveRun({ code: code ?? -1, stdout, stderr }));
  });
}

/** Runs a CLI command that is expected to succeed and returns its parsed --json output. */
export async function cliJson(
  sandbox: Sandbox, args: string[], extraEnv: Record<string, string> = {},
): Promise<Record<string, any>> {
  const result = await runCli(sandbox, ['--json', ...args], extraEnv);
  if (result.code !== 0) {
    throw new Error(`taskmd ${args.join(' ')} failed with ${result.code}: ${result.stderr || result.stdout}`);
  }
  const last = result.stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(last) as Record<string, any>;
}

/** Creates one task through the CLI and returns its ID. */
export async function createTask(sandbox: Sandbox, title: string): Promise<string> {
  const result = await runCli(sandbox, ['--json', 'create', title]);
  if (result.code !== 0) throw new Error(`create failed: ${result.stderr}`);
  return (JSON.parse(result.stdout.trim()) as { ids: Record<string, string> }).ids.task!;
}

/** Absolute path of the per-store local state directory (`root/local/<sha256(store)>`). */
export async function localStateDirectory(sandbox: Sandbox): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(join(sandbox.home, '.taskmd', 'local'));
  if (entries.length !== 1) throw new Error(`Expected one local state directory, found ${entries.length}.`);
  return join(sandbox.home, '.taskmd', 'local', entries[0]!);
}
