import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    env: { SKIP_ENV_VALIDATION: '1' },
  },
  // Automatic runtime for the handful of .tsx source files a unit test now
  // imports (station-period-note.test.ts, Block 8a Task 3). tsconfig.json
  // sets `jsx: "preserve"` for Next's own SWC transform; esbuild does not read
  // that, defaults to the classic runtime, and a component that returns actual
  // JSX (rather than null) then throws "React is not defined" at render time,
  // because the classic transform compiles `<p>` to a bare `React.createElement`
  // call instead of importing it. This makes esbuild use the same
  // import-per-file runtime Next already uses in the app itself.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // See the stub for why. Next.js still enforces the real thing at build time.
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
});
