// Bundle one Function app's src/functions/*.ts into <appDir>/.publish/dist/src/functions
// Usage: node scripts/bundle-functions.mjs <appDir>
import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const appDir = resolve(process.argv[2] ?? '.');
const srcDir = join(appDir, 'src', 'functions');
const entryPoints = readdirSync(srcDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => join(srcDir, f));

if (entryPoints.length === 0) {
  console.error(`No .ts entry points in ${srcDir}`);
  process.exit(1);
}

await build({
  entryPoints,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // @azure/functions-core is provided by the Functions host's node worker;
  // pg-native is pg's optional native binding (never installed — try/catch'd require)
  external: ['@azure/functions-core', 'pg-native'],
  // esbuild rewrites import.meta to {} in cjs output; @azure/storage-* calls
  // createRequire(import.meta.url) at load time — give it the real file URL
  define: { 'import.meta.url': '__bundledImportMetaUrl' },
  banner: { js: "const __bundledImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  outdir: join(appDir, '.publish', 'dist', 'src', 'functions'),
  logLevel: 'info',
});
