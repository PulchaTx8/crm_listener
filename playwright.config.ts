import { defineConfig } from '@playwright/test';
import { LOCAL_SUPABASE_ENV } from './tests/local-supabase';

export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'http://localhost:3000' },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    // The dev server points at the local stack, not at whatever `.env` holds:
    // `.env` names the hosted project and the middleware calls Supabase on
    // every request, so without this the suite would exercise production.
    env: { SKIP_ENV_VALIDATION: '1', ...LOCAL_SUPABASE_ENV },
  },
});
