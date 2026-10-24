#!/usr/bin/env node
// Prefer the prebuilt bundle so published installs need neither tsx nor the TypeScript
// sources; source checkouts without lib/ fall back to running src/ through tsx.
import { existsSync } from 'node:fs';

const bundled = new URL('../lib/cli.js', import.meta.url);
const { main } = existsSync(bundled)
  ? await import(bundled)
  : await import('tsx/esm/api').then(({ tsImport }) => tsImport('../src/cli.ts', import.meta.url));
await main(process.argv);
