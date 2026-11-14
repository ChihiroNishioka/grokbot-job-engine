import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  use: {
    baseURL: 'http://127.0.0.1:3322',
    ...(existsSync('/usr/bin/google-chrome') ? { channel: 'chrome' as const } : {}),
  },
  webServer: {
    command: 'node --import tsx scripts/dashboard-ui-server.ts',
    url: 'http://127.0.0.1:3322/',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
