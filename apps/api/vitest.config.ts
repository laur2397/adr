import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one database; run files one after another.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/flux_test',
      ANAF_MODE: 'mock',
      SIGNATURE_PROVIDER: 'simulated',
      STORAGE_DIR: join(tmpdir(), 'flux-test-storage'),
      APP_KEY: Buffer.alloc(32, 7).toString('base64'),
      SMTP_URL: '',
    },
  },
});
