import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    include: [
      'tests/**/*.test.{ts,tsx}',
      'modules/tests/**/*.test.{ts,tsx}',
      'users/*/tests/**/*.test.{ts,tsx}',
    ],
    // Stays 'node'. jsdom is opted into per FILE with a
    // `// @vitest-environment jsdom` docblock (onboarding ledger D9), so the
    // ~790 tests that never touch a DOM keep running at their current speed
    // instead of paying for a document each.
    environment: 'node',
  },
  resolve: {
    alias: { '@': resolve(__dirname, '.') },
  },
})
