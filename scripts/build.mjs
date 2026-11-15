import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const common = {
  absWorkingDir: root,
  bundle: true,
  sourcemap: true,
  minify: false,
  keepNames: true,
  logLevel: 'info',
  tsconfig: 'tsconfig.json',
};

// The Gateway supports source metadata: its argument reader needs these names.
// All DSH Host services retain the host's module identity.
await build({
  ...common,
  entryPoints: ['src/dsh/host.ts'],
  outfile: 'lib/index.js',
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['@deepseek-ai/*'],
  banner: { js: "import { createRequire as __taskmdCreateRequire } from 'node:module'; const require = __taskmdCreateRequire(import.meta.url);" },
});

// DSH Client modules register a lazy CommonJS factory, not an ESM entry.
// React and the platform store must be the exact instances supplied by DSH.
// Browser-safe Remote metadata and Zod are bundled here.
await build({
  ...common,
  entryPoints: ['src/dsh/client.tsx'],
  outfile: 'lib/client.js',
  platform: 'browser',
  target: 'es2022',
  format: 'cjs',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/dsh-client-store'],
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text' },
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; }});' },
});
