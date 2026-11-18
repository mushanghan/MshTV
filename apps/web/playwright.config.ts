import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './e2e', workers: 1, timeout: 30000, use: { baseURL: 'http://127.0.0.1:5193', viewport: { width: 1440, height: 960 }, trace: 'retain-on-failure' }, webServer: [
  { command: 'node ../../tools/test-server.mjs', url: 'http://127.0.0.1:5198/api/v1/health', timeout: 30000 },
  { command: 'npm run dev -- --port 5193', url: 'http://127.0.0.1:5193', env: { MSHTV_API_URL: 'http://127.0.0.1:5198' }, timeout: 30000 },
] });
