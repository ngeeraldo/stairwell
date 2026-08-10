import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    include: [
      'tests/**/*.test.ts',
      'modules/tests/**/*.test.ts',
      'users/*/tests/**/*.test.ts',
    ],
    environment: 'node',
  },
  resolve: {
    alias: { '@': resolve(__dirname, '.') },
  },
})
