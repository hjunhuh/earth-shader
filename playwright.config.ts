import { defineConfig } from '@playwright/test'

const metalArgs = ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal']
const swiftArgs = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4174',
    viewport: { width: 640, height: 360 },
  },
  // Always a fresh build on a dedicated port: never reuse a dev/preview server
  // that may be serving a stale bundle.
  webServer: {
    command: 'npm run build && npx vite preview --port 4174 --strictPort',
    url: 'http://localhost:4174',
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    {
      name: 'metal',
      testIgnore: /bench\.spec\.ts/,
      use: { channel: 'chromium', launchOptions: { args: metalArgs } },
    },
    {
      name: 'swiftshader',
      testIgnore: /bench\.spec\.ts/,
      use: { channel: 'chromium', launchOptions: { args: swiftArgs } },
    },
    {
      name: 'bench',
      testMatch: /bench\.spec\.ts/,
      use: {
        channel: 'chromium',
        viewport: { width: 1920, height: 1080 },
        launchOptions: { args: [...metalArgs, '--disable-gpu-vsync', '--disable-frame-rate-limit'] },
      },
    },
  ],
})
