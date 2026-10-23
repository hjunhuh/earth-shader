import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * Test build: the app plus the takram reference page (tests/reference). The
 * reference pulls in React/R3F, so it is never part of the production build.
 * Otherwise identical to vite.config.ts.
 */
export default defineConfig({
  preview: { port: 4174, strictPort: true },
  build: {
    target: 'es2023',
    outDir: 'dist-test',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        takram: resolve(import.meta.dirname, 'tests/reference/takram.html'),
      },
    },
  },
})
