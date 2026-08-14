/**
 * Headless screenshots of every live screen, at both widths, for review before
 * a commit (onboarding ledger D16).
 *
 *   npm run shots -- --task=9
 *   npm run shots -- --task=9 --only=s2-set-password
 *   npm run shots -- --task=9 --no-build       # reuse the existing .next
 *
 * SYNTHETIC ONLY, and structurally so: this builds its own platform database
 * in a temp directory and points USERS_DIR at a temp tree. It never opens
 * anything under the repo's own users/ or platform/dev/, and it REFUSES TO RUN
 * if PLATFORM_DB names a path inside the repo. CLAUDE.md > Data safety — a
 * screenshot is a file on disk that outlives the run, so a harness that could
 * point at real data would be the worst possible place to be careless.
 *
 * It also never passes ANTHROPIC_API_KEY through: no screen here needs a model
 * call, and a harness that could bill is a harness that eventually will.
 *
 * What it does NOT do: assert anything. The assertions live in
 * screenshots/screens.ts as prose and are read against the images by a person
 * (or by Claude, reading the PNG). This is a review gate, not a test — see the
 * ledger for why a pixel-diff suite would be worse than nothing here.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type BrowserContext, type Page } from '@playwright/test'
import { SCREENS, VIEWPORT_HEIGHT, WIDTHS, type Screen, type ScreenState } from '../screenshots/screens'

const PORT = Number(process.env.SHOTS_PORT ?? 3987)
const ORIGIN = `http://127.0.0.1:${PORT}`
const REPO = resolve(__dirname, '..')
const OUT_ROOT = join(REPO, '.screenshots')

type Args = { task: string; only?: string; build: boolean }

function parseArgs(argv: string[]): Args {
  const get = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
  return {
    task: get('task') ?? 'adhoc',
    only: get('only'),
    build: !argv.includes('--no-build'),
  }
}

/**
 * The data-safety guard, asserted rather than trusted.
 *
 * If someone runs this with PLATFORM_DB already exported — which is exactly
 * what `docs/local-dev.md` tells them to do for the other scripts — the
 * harness must not inherit it and photograph a real account. Refuse loudly
 * instead of silently overriding, because silently overriding trains people
 * to think the variable was respected.
 */
function guardPlatformDb(env: NodeJS.ProcessEnv, repoRoot: string): void {
  const set = env.PLATFORM_DB
  if (!set) return
  const abs = resolve(set)
  if (abs.startsWith(repoRoot + '/') || abs === repoRoot) {
    throw new Error(
      `Refusing to run: PLATFORM_DB is set to ${abs}, inside the repo. ` +
        'scripts/shots.ts builds its own synthetic database in a temp directory ' +
        'and must never open a real one (CLAUDE.md > Data safety). Unset ' +
        'PLATFORM_DB and re-run.',
    )
  }
  throw new Error(
    `Refusing to run: PLATFORM_DB is set to ${abs}. This harness seeds its own ` +
      'database and ignores yours; unset it so it cannot be mistaken for the ' +
      'thing being photographed.',
  )
}

/** What a seeder hands back: the cookie (if any) and the path substitutions. */
type Fixture = { sessionId?: string; slug?: string; token?: string }

type Seeder = (dbPath: string, usersDir: string) => Promise<Fixture>

/**
 * One seeder per state, each built through the REAL library functions.
 *
 * Never hand-written INSERTs: a fixture assembled by hand drifts from what the
 * application actually writes, and then the shots show a screen no user will
 * ever see. That is worse than no screenshot, because it looks like evidence.
 *
 * States arrive as their tasks land. A screen whose state has no seeder here
 * cannot be `live` in screenshots/screens.ts — tests/scripts/shots.test.ts
 * pins that, so the two files cannot drift apart.
 */
const SEEDERS: Partial<Record<ScreenState, Seeder>> = {
  anonymous: async () => ({}),

  'invite-valid': async (dbPath) => {
    const { openPlatformDb } = await import('../lib/db/platform')
    const { mintInvite } = await import('../lib/invite/tokens')
    const db = openPlatformDb(dbPath)
    try {
      // Loudly fake, like every other fixture in this repo: nobody reviewing a
      // screenshot should have to wonder whether they are looking at a person.
      return { token: mintInvite(db, { slug: 'friendtest', at: Date.now() }), slug: 'friendtest' }
    } finally {
      db.close()
    }
  },

  'invite-used': async (dbPath) => {
    const { openPlatformDb } = await import('../lib/db/platform')
    const { createAccount } = await import('../lib/auth/accounts')
    const { mintInvite, consumeInvite } = await import('../lib/invite/tokens')
    const db = openPlatformDb(dbPath)
    try {
      const token = mintInvite(db, { slug: 'spenttest', at: Date.now() })
      // Consumed through the real function, against a real account, because
      // the invites.account_id foreign key is real — and because a fixture
      // built by hand drifts from what the app writes.
      const id = await createAccount(db, {
        slug: 'spenttest',
        role: 'user',
        password: 'TEST-SHOTS-NOT-A-REAL-PASSWORD',
      })
      consumeInvite(db, { token, accountId: id, at: Date.now() })
      return { token, slug: 'spenttest' }
    } finally {
      db.close()
    }
  },

  'friend-locked': async (dbPath) => {
    const { openPlatformDb } = await import('../lib/db/platform')
    const { createAccount } = await import('../lib/auth/accounts')
    const { createSession } = await import('../lib/session/store')
    const db = openPlatformDb(dbPath)
    try {
      // A session row with NO key in the process keymap — which is what an
      // authenticated-but-locked session actually is, and the only honest way
      // to photograph /unlock. The key map lives in the SERVER process, so a
      // cookie minted here can never be unlocked from here by construction.
      const id = await createAccount(db, {
        slug: 'friendtest',
        role: 'user',
        password: 'TEST-SHOTS-NOT-A-REAL-PASSWORD',
      })
      return { sessionId: createSession(db, id), slug: 'friendtest' }
    } finally {
      db.close()
    }
  },
}

async function waitForServer(page: Page, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await page.goto(`${ORIGIN}/login`, { timeout: 3000 })
      if (response && response.status() === 200) return
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`server never served ${ORIGIN}/login after ${attempts} polls`)
}

/**
 * Post-navigation interactions, by name.
 *
 * Kept as a closed set rather than arbitrary callbacks in screens.ts: a screen
 * list that can run code is a screen list nobody reads.
 */
async function performAct(page: Page, act: string): Promise<void> {
  switch (act) {
    case 'collapse-chat':
      await page.getByRole('button', { name: /hide chat/i }).click()
      break
    case 'open-fullscreen':
      await page.getByRole('button', { name: /view full screen/i }).click()
      break
    case 'tab-spec':
      await page.getByRole('tab', { name: /spec/i }).click()
      break
    case 'tab-mockup':
      await page.getByRole('tab', { name: /mockup/i }).click()
      break
    default:
      throw new Error(`unknown act: ${act}`)
  }
  // Let whatever it opened settle. No animation is configured, so this is
  // about React committing, not about waiting out a transition.
  await page.waitForTimeout(150)
}

function pathFor(screen: Screen, fixture: Fixture): string {
  return screen.path
    .replace('TOKEN', fixture.token ?? 'no-token-seeded')
    .replace('SLUG', fixture.slug ?? 'no-slug-seeded')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  guardPlatformDb(process.env, REPO)

  const live = SCREENS.filter((s) => s.live && (!args.only || s.id === args.only))
  const skipped = SCREENS.filter((s) => !s.live)

  if (live.length === 0) {
    console.error(
      args.only
        ? `No live screen matches --only=${args.only}.`
        : 'No screens are live yet.',
    )
    process.exitCode = 1
    return
  }

  if (args.build) {
    console.log('Building…')
    execFileSync('npx', ['next', 'build'], { cwd: REPO, stdio: 'inherit' })
  }

  const root = mkdtempSync(join(tmpdir(), 'stairwell-shots-'))
  const dbPath = join(root, 'platform.db')
  const usersDir = join(root, 'users')
  mkdirSync(usersDir, { recursive: true })

  const outDir = join(OUT_ROOT, `task-${args.task}`)
  mkdirSync(outDir, { recursive: true })

  let server: ChildProcess | undefined
  const browser = await chromium.launch()
  try {
    server = spawn('npx', ['next', 'start', '-p', String(PORT), '-H', '127.0.0.1'], {
      cwd: REPO,
      env: {
        ...process.env,
        PLATFORM_DB: dbPath,
        USERS_DIR: usersDir,
        // Explicitly absent, not merely unset upstream.
        ANTHROPIC_API_KEY: '',
        NTFY_TOPIC: '',
        NODE_ENV: 'production',
      },
      stdio: 'ignore',
    })

    const warm = await browser.newContext()
    await waitForServer(await warm.newPage())
    await warm.close()

    const shots: { file: string; screen: Screen }[] = []

    for (const screen of live) {
      const seed = SEEDERS[screen.state]
      if (!seed) throw new Error(`no seeder for state '${screen.state}' (${screen.id})`)
      const fixture = await seed(dbPath, usersDir)

      for (const width of WIDTHS) {
        const context: BrowserContext = await browser.newContext({
          viewport: { width, height: VIEWPORT_HEIGHT[width] },
        })
        if (fixture.sessionId) {
          await context.addCookies([
            {
              name: 'stairwell_session',
              value: fixture.sessionId,
              url: ORIGIN,
            },
          ])
        }
        const page = await context.newPage()
        await page.goto(`${ORIGIN}${pathFor(screen, fixture)}`, {
          waitUntil: 'networkidle',
        })
        if (screen.act) await performAct(page, screen.act)

        const file = join(outDir, `${screen.id}-${width}.png`)
        await page.screenshot({ path: file, fullPage: true })
        shots.push({ file, screen })
        await context.close()
      }
    }

    console.log(`\nShots in ${outDir}\n`)
    console.log('REVIEW CHECKLIST — read each image against its lines.\n')
    for (const { file, screen } of shots) {
      console.log(file)
      for (const line of screen.assertions) console.log(`   - ${line}`)
      console.log('')
    }

    // No silent caps. A gate that quietly covered eight of sixteen screens
    // reads exactly like a gate that covered all sixteen.
    if (skipped.length > 0) {
      console.log(`NOT YET LIVE (${skipped.length}), so NOT reviewed this run:`)
      for (const s of skipped) console.log(`   - ${s.id}`)
      console.log('')
    }
  } finally {
    server?.kill('SIGTERM')
    await browser.close()
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
