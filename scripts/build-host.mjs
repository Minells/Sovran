// Bundles the extension host (core + extension + shared) into a single CommonJS file, and the document worker (the
// document parsers, pdf.js included) into a second one, so the parsers never load in the extension host itself.
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: {
    extension: 'src/extension/extension.ts',
    documentWorker: 'src/extension/adapters/documentWorker.ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outdir: 'dist',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  legalComments: 'linked',
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
