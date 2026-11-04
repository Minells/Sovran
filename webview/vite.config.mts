import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

// ESM config (.mts): the root package.json cannot set "type": "module", because the extension host bundle
// (dist/extension.js) is CommonJS.
//
// The webview is loaded from disk by VS Code, so assets must use relative URLs and
// a single deterministic entry file (dist/webview/assets/index.js) that the host references.
export default defineConfig(({ mode }) => ({
  root,
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist/webview', import.meta.url)),
    emptyOutDir: true,
    sourcemap: mode === 'development',
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    // Vite's 500 kB default is meant for pages downloaded over the network. This bundle is read from local disk,
    // where splitting it would only add files. The limit is a budget instead: about 15% above the current size
    // (react-dom, markdown-it, highlight.js with 23 languages, DOMPurify), so an accidental heavy import (all of
    // highlight.js, zod in the webview) still warns. Measure with a sourcemap build before raising it.
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/[name].js',
        // The host references assets/index.css explicitly; keep other assets (fonts) by name.
        assetFileNames: (info) => (info.names?.some((n) => n.endsWith('.css')) ? 'assets/index.css' : 'assets/[name][extname]'),
      },
    },
  },
}));
