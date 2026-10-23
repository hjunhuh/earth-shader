import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 5173 },
  preview: { port: 4173, strictPort: true },
  build: {
    target: 'es2023',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
})
