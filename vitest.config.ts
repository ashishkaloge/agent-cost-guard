import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Keep test runs out of the developer's real decision log. Log tests opt in
    // with a temporary AGENT_COST_GUARD_LOG_FILE.
    env: { AGENT_COST_GUARD_LOG: 'off' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
  },
});
