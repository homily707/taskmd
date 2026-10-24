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
// Browser-safe Remote metadata, graph libraries and Zod are bundled here.
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

// Standalone Web UI: the same React app the DSH client mounts, driven by the
// HTTP port. React is bundled here because `taskmd serve` is a closed page with
// no module loader. `@xyflow/react` ships its stylesheet as CSS, so it enters
// the bundle as text (the `<style>` element is rendered by the component).
await build({
  ...common,
  entryPoints: ['src/web/main.tsx'],
  outfile: 'lib/web.js',
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text' },
});

// Standalone CLI bundle: `npx taskmd` then needs no tsx and no TypeScript sources.
// The createRequire banner is required: commander/proper-lockfile are CJS and
// issue dynamic require("node:events") calls that break in ESM bundles.
await build({
  ...common,
  entryPoints: ['src/cli.ts'],
  outfile: 'lib/cli.js',
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  banner: { js: "import { createRequire as __taskmdCreateRequire } from 'node:module'; const require = __taskmdCreateRequire(import.meta.url);" },
});
