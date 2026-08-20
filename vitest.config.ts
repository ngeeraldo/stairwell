import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    include: [
      'tests/**/*.test.{ts,tsx}',
      'modules/tests/**/*.test.{ts,tsx}',
      'users/*/tests/**/*.test.{ts,tsx}',
    ],
    // LIVE SHAPE TESTS ARE OPT-IN AND NEVER RUN HERE (CLAUDE.md > Testing).
    // `*.live.test.ts` reaches a third party over the network, so it must not
    // sit in Gate E or a deploy: an upstream outage must not be able to block
    // shipping an unrelated fix. Added with
    // tests/weather/openMeteo.live.test.ts, the first one.
    //
    // OPT IN WITH `npm run test:live`, which sets VITEST_LIVE. It is an env
    // var rather than a CLI flag because vitest's `--exclude` APPENDS to this
    // list instead of replacing it, so there is no command line that can
    // un-exclude a file the config excluded. Defaulting to the excluded list
    // means a fresh clone, Gate E and a deploy all stay off the network
    // without knowing this variable exists.
    exclude:
      process.env.VITEST_LIVE === '1'
        ? ['**/node_modules/**']
        : ['**/node_modules/**', '**/*.live.test.{ts,tsx}'],
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
