import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each run uses a fresh data directory so tests never touch real projects.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-e2e-'));
const port = Number(process.env.VOIDCRAFT_E2E_PORT || 5288);
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1600, height: 950 },
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node dist-server/server/index.js',
    url: `http://127.0.0.1:${port}/api/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: { VOIDCRAFT_PORT: String(port), VOIDCRAFT_DATA_DIR: dataDir, VOIDCRAFT_POLL_MS: '300', VOIDCRAFT_QUIET: '1' },
  },
});
