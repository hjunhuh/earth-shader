import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

// Real GPU (ANGLE/Metal) locally, SwiftShader on CI.
const gpuArgs = process.env.CI
  ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal']

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: 60_000,
        },
      },
      {
        define: { 'import.meta.env.CI': JSON.stringify(Boolean(process.env.CI)) },
        optimizeDeps: { include: ['three', 'lil-gui', 'fast-check'] },
        test: {
          name: 'gpu',
          include: ['tests/gpu/**/*.gpu.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
          browser: {
            enabled: true,
            headless: true,
            viewport: { width: 512, height: 512 },
            provider: playwright({ launchOptions: { channel: 'chromium', args: gpuArgs } }),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
