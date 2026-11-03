import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
        },
      },
      {
        // Inline projects extend this file since Vitest 5, so the React plugin above already applies here.
        test: {
          name: 'webview',
          environment: 'jsdom',
          include: ['webview/src/**/*.test.tsx', 'webview/src/**/*.test.ts'],
          setupFiles: ['webview/src/test/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/shared/**', 'webview/src/**'],
      exclude: ['**/*.test.*', 'webview/src/test/**', 'webview/src/dev/**'],
    },
  },
});
