import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    locale: 'ro-RO',
    timezoneId: 'Europe/Bucharest',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : undefined,
  },
  webServer: {
    command: 'bash tests/e2e/start-server.sh',
    url: `http://localhost:${port}/api/v1/ready`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'ignore',
  },
});
