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

/**
 * What a seeder hands back.
 *
 * `sessionId` mints a cookie directly, which produces an AUTHENTICATED but
 * LOCKED session — the derived key lives in the SERVER's in-process keymap and
 * a cookie made out here can never be in it. That is exactly right for /unlock
 * and wrong for everything else.
 *
 * `password` instead makes the harness log in through the real form, which is
 * the only way to get an UNLOCKED session: the key has to be put in the map by
 * the process that will later read it.
 */
type Fixture = {
  sessionId?: string
  password?: string
  slug?: string
  token?: string
  /** Log in as `nico` rather than as `slug` — the admin screens' path segment
   *  is the FRIEND's slug while the session belongs to the admin. */
  admin?: boolean
}

type Seeder = (dbPath: string, usersDir: string) => Promise<Fixture>

/**
 * Build a friend's REAL, encrypted database the way production builds it.
 *
 * The server this harness spawns runs `NODE_ENV=production`, so
 * lib/db/userData.ts serves the encrypted `<slug>.db` and nothing else — there
 * is no synthetic fallback any more. A fixture that dropped a `synthetic.db`
 * into USERS_DIR therefore rendered "This dashboard failed to load", which is
 * exactly what the first shot of the empty-dashboard screen showed. Every test
 * in the suite was green at the time; only the picture disagreed.
 *
 * Mirrors the login path rather than approximating it: derive the account's
 * key the way `app/api/login/route.ts` does, then run the real migration
 * runner. Copying the migrations into USERS_DIR first is what lets the runner
 * find them — it reads from `usersRoot()`, which is the temp tree.
 *
 * NODE_ENV is forced to production around the runner because THIS process is
 * not the server: outside production the runner returns immediately, so
 * without it the fixture would silently build nothing at all.
 */
async function buildFriendsRealDb(
  db: import('../lib/db/platform').PlatformDb,
  usersDir: string,
  slug: string,
  password: string,
  seedRows?: (handle: import('better-sqlite3-multiple-ciphers').Database) => void,
): Promise<void> {
  const { findAccountBySlug } = await import('../lib/auth/accounts')
  const { databaseKeyFor } = await import('../lib/auth/flow')
  const { migrateUserDb } = await import('../lib/db/migrate')
  const { openEncryptedUserDb } = await import('../lib/db/encryptedUserDb')
  const { cpSync, mkdirSync } = await import('node:fs')

  mkdirSync(join(usersDir, slug), { recursive: true })
  cpSync(join(REPO, 'users', slug, 'migrations'), join(usersDir, slug, 'migrations'), {
    recursive: true,
  })

  const account = findAccountBySlug(db, slug)
  if (!account) throw new Error(`shots: no account for '${slug}'`)
  const key = await databaseKeyFor(db, account, password)

  const before = process.env.NODE_ENV
  ;(process.env as Record<string, string | undefined>).NODE_ENV = 'production'
  try {
    migrateUserDb(slug, key)
    if (seedRows) {
      const handle = openEncryptedUserDb(slug, key)
      try {
        seedRows(handle)
      } finally {
        handle.close()
      }
    }
  } finally {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = before
  }
}

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
      // EVERY STATE IN A RUN SHARES ONE DATABASE, so every fixture needs its
      // own slug: accounts.slug and invites.slug are both UNIQUE, and two
      // fixtures reaching for the same name is a constraint violation rather
      // than a coincidence. They are all loudly fake and all end in `test`.
      return { token: mintInvite(db, { slug: 'invitetest', at: Date.now() }), slug: 'invitetest' }
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

  /** A friend who has registered but has no dashboard built yet. */
  'friend-new': async (dbPath) => {
    const { openPlatformDb } = await import('../lib/db/platform')
    const { mintInvite } = await import('../lib/invite/tokens')
    const { registerFromInvite } = await import('../lib/invite/register')
    const db = openPlatformDb(dbPath)
    try {
      // Through the REAL registration path, not a hand-built account: it is
      // the only way to be sure the screenshot shows the state a friend is
      // actually in after S2, down to the empty encrypted database.
      const password = 'TEST-SHOTS-NOT-A-REAL-PASSWORD'
      // A DIFFERENT slug from the invite-valid fixture: every state in a run
      // shares one database, and two invites for one slug is a UNIQUE
      // violation — which is the constraint doing its job, not a nuisance.
      const token = mintInvite(db, { slug: 'newfriendtest', at: Date.now() })
      const result = await registerFromInvite(db, { token, password, at: Date.now() })
      if (!result.ok) throw new Error(`friend-new seed failed: ${result.reason}`)

      // A proposal to look at, so the card screens have a card.
      //
      // Built through parseSpecDraft + sealVersion, NOT hand-written into the
      // payload column. The first attempt was hand-written, failed validation
      // for a reason that was not obvious (a panel with no values), and the
      // page did exactly what it is supposed to do with an unreadable row:
      // degrade silently to no card. A screenshot of an empty chat panel looks
      // a lot like a screenshot of a working one.
      //
      // Validating here means a bad fixture THROWS in the harness instead.
      const { insertSpec } = await import('../lib/db/specs')
      const { findAccountBySlug } = await import('../lib/auth/accounts')
      const { parseSpecDraft, sealVersion } = await import('../lib/spec/validate')
      const account = findAccountBySlug(db, 'newfriendtest')!

      // A few turns, so the chat surface can be REVIEWED as a conversation
      // rather than as an empty column with a card in it.
      //
      // Added when user and agent turns stopped being visually identical: the
      // difference is a picture, and until this fixture existed there was no
      // picture of a friend's chat with anything in it — every shot showed the
      // proposal card above an empty transcript. A shot that cannot show the
      // change is not a review.
      //
      // The agent turn carries a deliberate blank line, because collapsing
      // those was the second half of the same defect.
      const { appendTranscript } = await import('../lib/db/appendOnly')
      const conversation = [
        ['user', 'I walk the dog every morning and I keep losing track of whether I actually went.'],
        [
          'assistant',
          'That is a good thing to track — one tap, one number, nothing to think about.\n\n' +
            'Before I put a preview together: is the streak the thing you want to see, ' +
            'or would you rather see the last couple of weeks at a glance?',
        ],
        ['user', 'The streak. I want to not want to break it.'],
      ] as const
      conversation.forEach(([role, body], index) => {
        appendTranscript(db, {
          accountId: account.id,
          sessionId: 'shots-session',
          conversationId: 'shots-conversation',
          promptSha: 'shots-fixture',
          role,
          body,
          // Strictly before the proposal below, so the card lands at the end
          // of the conversation the way a real one does.
          at: Date.now() - (10 - index) * 60_000,
        })
      })
      const draft = parseSpecDraft({
        title: 'COFFEE PALACE TEST tracker',
        summary: 'A one-tap tracker for the walk and the coffee.',
        change_summary: 'Added a streak panel and a coffee count.',
        background: 'Walks the dog every morning TEST.',
        open_questions: [],
        data_requirements: [],
        screens: [
          {
            id: 'home',
            title: 'Home',
            order: 1,
            panels: [
              {
                id: 'streak',
                title: 'Streak',
                intent: 'So the run is visible at a glance.',
                display: 'Days in a row you walked.',
                context_of_use: null,
                values: [
                  {
                    kind: 'entered',
                    id: 'walk_flag',
                    description: 'Whether the walk happened today.',
                  },
                ],
                entry: null,
              },
            ],
          },
        ],
      })
      insertSpec(db, {
        accountId: account.id,
        conversationId: 'shots-conversation',
        promptSha: 'shots-fixture',
        payload: sealVersion(draft, null, null),
        mockupHtml:
          '<!doctype html><html><body style="font-family:system-ui;padding:24px">' +
          '<h1 style="margin:0 0 8px">COFFEE PALACE TEST tracker</h1>' +
          '<p style="color:#666;margin:0 0 24px">Every number here is fake.</p>' +
          '<div style="border:1px solid #ddd;border-radius:12px;padding:16px">' +
          '<div style="font-size:12px;color:#666">Streak</div>' +
          '<div style="font-size:40px;font-weight:600">7 days</div></div>' +
          '</body></html>',
        at: Date.now(),
      })

      return { slug: 'newfriendtest', password }
    } finally {
      db.close()
    }
  },

  /**
   * A friend with an already-built two-screen dashboard, plus a NEW proposal
   * that renames one panel on just one of those screens — task 19's fixture,
   * for card-proposal-scoped.
   *
   * Its only consumer, card-proposal-scoped, is `live: false` (the card it
   * photographed no longer renders anywhere — see screenshots/screens.ts), so
   * this seeder no longer runs in an ordinary capture. Left in place rather
   * than deleted, same as that screen row: a future removal of the id is what
   * should decide whether this goes too, not a shots.ts edit alone.
   *
   * Built through parseSpecDraft + sealVersion, same as friend-new above, so a
   * malformed fixture throws in the harness instead of silently degrading to
   * no card. Two spec rows and two insertScreenMockups calls, mirroring what
   * authorSpec actually writes (lib/spec/author.ts): v1 whole-surface, v2 a
   * patch that only touches `money`, carrying `home`'s fragment forward
   * unchanged. This is the ONLY fixture in this file that calls
   * insertScreenMockups — every other one predates the scoped preview and is
   * a legitimate no-fragments row. v1 no longer needs confirming — nothing
   * does; the row existing is what makes it current.
   */
  'friend-tweak': async (dbPath) => {
    const { openPlatformDb } = await import('../lib/db/platform')
    const { createAccount } = await import('../lib/auth/accounts')
    const { insertSpec } = await import('../lib/db/specs')
    const { insertScreenMockups } = await import('../lib/db/screenMockups')
    const { parseSpecDraft, sealVersion } = await import('../lib/spec/validate')
    const { appendTranscript } = await import('../lib/db/appendOnly')
    const db = openPlatformDb(dbPath)
    try {
      const password = 'TEST-SHOTS-NOT-A-REAL-PASSWORD'
      const accountId = await createAccount(db, { slug: 'tweaktest', role: 'user', password })

      const base = Date.now() - 120_000
      const say = (role: 'user' | 'assistant', body: string, at: number) =>
        appendTranscript(db, {
          accountId,
          sessionId: 'shots-session',
          conversationId: 'shots-conversation',
          promptSha: 'shots-fixture',
          role,
          body,
          at,
        })
      say('user', 'Can you relabel "Eating out" to "Dining"? TEST', base)
      say('assistant', 'Done — here is the updated Money screen. TEST', base + 1000)

      const draft = parseSpecDraft({
        title: 'COFFEE PALACE TEST tracker',
        summary: 'A daily walk streak plus the eating-out total.',
        change_summary: 'First version.',
        background: 'Walks the dog every morning TEST.',
        open_questions: [],
        data_requirements: [],
        screens: [
          {
            id: 'home',
            title: 'Home',
            order: 1,
            panels: [
              {
                id: 'streak',
                title: 'Streak',
                intent: 'So the run is visible at a glance.',
                display: 'Days in a row you walked.',
                context_of_use: null,
                values: [
                  { kind: 'entered', id: 'walk_flag', description: 'Whether the walk happened today.' },
                ],
                entry: null,
              },
            ],
          },
          {
            id: 'money',
            title: 'Money',
            order: 2,
            panels: [
              {
                id: 'eating_out',
                title: 'Eating out',
                intent: 'Watch the spend without opening the banking app.',
                display: 'This month against last.',
                context_of_use: null,
                values: [
                  { kind: 'derived', id: 'eating_out_total', description: 'Sum this month.', inputs: [] },
                ],
                entry: null,
              },
            ],
          },
        ],
      })

      // Distinct fragment strings per screen per version, so the shot can be
      // read at a glance: `home` is IDENTICAL in both versions (carried
      // forward, not redrawn) and `money`'s panel title is the only thing
      // that changes.
      const homeFragment =
        '<div class="screen-title">Home</div><div class="panel"><div class="panel-title">Streak</div><div class="figure">7 days</div></div>'
      const moneyFragmentV1 =
        '<div class="screen-title">Money</div><div class="panel"><div class="panel-title">Eating out</div><div class="figure">£45.00</div></div>'
      const moneyFragmentV2 =
        '<div class="screen-title">Money</div><div class="panel"><div class="panel-title">Dining</div><div class="figure">£45.00</div></div>'

      const v1 = sealVersion(draft, null, null)
      const v1Id = insertSpec(db, {
        accountId,
        conversationId: 'shots-conversation',
        promptSha: 'shots-fixture',
        payload: v1,
        mockupHtml: `<!doctype html><html><body>${homeFragment}${moneyFragmentV1}</body></html>`,
        at: base + 2000,
      })
      insertScreenMockups(
        db,
        v1Id,
        [
          { screenId: 'home', html: homeFragment },
          { screenId: 'money', html: moneyFragmentV1 },
        ],
        base + 2000,
      )

      // Final review, Minor 9: this used to model the rename as an
      // `update_screen` op naming the SCREEN ('money') with its title and
      // order both unchanged — a no-op shape that authorSpec never actually
      // produces for a panel-title rename. A rename to a panel's own title
      // is what `replace_panel` is for (lib/spec/patch.ts): the full updated
      // panel, matching id, is what `authorSpec` writes. Corrected to match
      // what this fixture claims to mirror.
      const renamedPanel = { ...draft.screens[1]!.panels[0]!, title: 'Dining' }
      const v2Draft = {
        ...draft,
        change_summary: 'Renamed "Eating out" to "Dining".',
        screens: [
          draft.screens[0]!,
          {
            ...draft.screens[1]!,
            panels: [renamedPanel],
          },
        ],
      }
      const v2 = sealVersion(v2Draft, 1, [{ op: 'replace_panel', panel: renamedPanel }])
      const v2Id = insertSpec(db, {
        accountId,
        conversationId: 'shots-conversation',
        promptSha: 'shots-fixture',
        payload: v2,
        mockupHtml: `<!doctype html><html><body>${homeFragment}${moneyFragmentV2}</body></html>`,
        at: base + 4000,
      })
      insertScreenMockups(
        db,
        v2Id,
        [
          { screenId: 'home', html: homeFragment }, // carried forward, untouched
          { screenId: 'money', html: moneyFragmentV2 }, // freshly drawn
        ],
        base + 4000,
      )

      return { slug: 'tweaktest', password }
    } finally {
      db.close()
    }
  },

  /** A friend whose dashboard has been deployed — devone's, in the registry. */
  'friend-built': async (dbPath, usersDir) => {
    const { openPlatformDb } = await import('../lib/db/platform')
    const { createAccount } = await import('../lib/auth/accounts')
    const db = openPlatformDb(dbPath)
    try {
      const password = 'TEST-SHOTS-NOT-A-REAL-PASSWORD'
      await createAccount(db, { slug: 'devone', role: 'user', password })
      await buildFriendsRealDb(db, usersDir, 'devone', password, (handle) => {
        // Loudly fake, like everything this harness touches (CLAUDE.md > Data
        // safety). These used to be copied wholesale out of devone's
        // synthetic.db; they are inserted here instead because the file the
        // server reads is the ENCRYPTED one, and only this process has the key.
        const insert = handle.prepare(
          'INSERT INTO transactions (merchant, category, amount_cents, at) VALUES (?, ?, ?, ?)',
        )
        // RELATIVE TO NOW, not a fixed date. devone's first panel totals
        // "eating out THIS MONTH", so rows pinned to a calendar date show
        // $0.00 for eleven months of the year — a screen that looks broken
        // while being technically correct, which is the worst kind of review
        // artifact. The dashboard is still handed its day by the page; only
        // this fixture reads a clock, and a script may.
        const day = 86_400_000
        const at = Date.now() - day
        insert.run('COFFEE PALACE TEST', 'eating out', 450, at)
        insert.run('COFFEE PALACE TEST', 'eating out', 380, at - day)
        insert.run('GROCERY WORLD TEST', 'groceries', 7756, at - 2 * day)
        insert.run('GROCERY WORLD TEST', 'groceries', 5182, at - 4 * day)
      })
      return { slug: 'devone', password }
    } finally {
      db.close()
    }
  },

  /**
   * A friend whose dashboard is deployed and whose database is EMPTY.
   *
   * The state every friend is in on the day their dashboard ships, and now
   * the state they actually SEE — there is no synthetic fallback to stand in
   * front of it. Built by giving the folder devone's migrations and no rows,
   * which is exactly what the runner leaves behind after applying 001 to a
   * database nobody has written to.
   */
  'friend-built-empty': async (dbPath, usersDir) => {
    const { openPlatformDb } = await import('../lib/db/platform')
    const { createAccount } = await import('../lib/auth/accounts')
    const db = openPlatformDb(dbPath)
    try {
      // devtwo, NOT devone: every state in a run shares one platform database,
      // and `friend-built` already holds that slug — two accounts for one slug
      // is a UNIQUE violation that aborts the whole capture. Using the other
      // registered dashboard also widens what this screen covers, since its
      // empty state is a different shape of nothing.
      const password = 'TEST-SHOTS-NOT-A-REAL-PASSWORD'
      await createAccount(db, { slug: 'devtwo', role: 'user', password })
      // Migrated and NOT written to — the state a friend is in on the morning
      // their dashboard ships. No seedRows callback, deliberately.
      await buildFriendsRealDb(db, usersDir, 'devtwo', password)
      return { slug: 'devtwo', password }
    } finally {
      db.close()
    }
  },

  /** Nico, plus a friend with a conversation, a proposal and a confirmation. */
  admin: async (dbPath) => {
    const { openPlatformDb } = await import('../lib/db/platform')
    const { createAccount } = await import('../lib/auth/accounts')
    const { appendTranscript } = await import('../lib/db/appendOnly')
    const { insertSpec } = await import('../lib/db/specs')
    const db = openPlatformDb(dbPath)
    try {
      const password = 'TEST-SHOTS-NOT-A-REAL-PASSWORD'
      await createAccount(db, { slug: 'nico', role: 'admin', password })
      const friend = await createAccount(db, {
        slug: 'admintest',
        role: 'user',
        password,
      })

      const base = Date.now() - 60_000
      const say = (role: string, body: string, at: number) =>
        appendTranscript(db, {
          accountId: friend,
          sessionId: 'shots-session',
          conversationId: 'shots-conversation',
          promptSha: 'shots-fixture',
          role,
          body,
          at,
        })
      say('user', 'I want to see whether I walked the dog. TEST', base)
      say('assistant', 'Got it — one tap a day, and a streak. TEST', base + 1000)
      const specId = insertSpec(db, {
        accountId: friend,
        conversationId: 'shots-conversation',
        promptSha: 'shots-fixture',
        payload: {
          title: 'COFFEE PALACE TEST tracker',
          summary: 'A one-tap tracker.',
          background: 'Walks the dog every morning TEST.',
          panels: [
            { name: 'Streak', shows: 'Days in a row', why: 'Momentum TEST', source: 'manual' },
          ],
          manual_logging: ['the walk'],
          open_questions: [],
        },
        mockupHtml:
          '<!doctype html><html><body style="font-family:system-ui;padding:24px">' +
          '<h1 style="margin:0 0 8px">COFFEE PALACE TEST tracker</h1>' +
          '<p style="color:#666">Every number here is fake.</p></body></html>',
        at: base + 2000,
      })
      say('user', 'That is exactly it. TEST', base + 3000)
      // Nothing in the application writes spec_confirmations any more
      // (lib/db/specs.ts's confirmSpec is gone), but admin-transcript's own
      // assertion still needs one on screen — "a confirmation appears as an
      // event at the point it happened" is about a real historical row, and
      // spec_confirmations keeps every row it already holds. Inserted
      // directly, the way tests/db/specs.test.ts's own fixtures now do.
      db.prepare(
        'INSERT INTO spec_confirmations (spec_id, account_id, at) VALUES (?, ?, ?)',
      ).run(specId, friend, base + 4000)

      // NOT the friend's slug: the admin index and the per-user pane both take
      // the SLUG in the path, and the session belongs to nico.
      return { slug: 'admintest', password, admin: true }
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
        slug: 'lockedtest',
        role: 'user',
        password: 'TEST-SHOTS-NOT-A-REAL-PASSWORD',
      })
      return { sessionId: createSession(db, id), slug: 'lockedtest' }
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
/**
 * Put the panel into the authoring wait and LEAVE IT THERE.
 *
 * The wait exists only mid-turn: the moment a stream ends, finishTurn clears
 * it. So a shot of it needs a reply that starts and never finishes, which is
 * also exactly what the friend is looking at while it is on screen.
 *
 * `window.fetch` is replaced rather than the route being intercepted, because
 * Playwright's fulfil sends a COMPLETE body — the stream would close, the wait
 * would clear, and the shutter would catch an empty column. ChatPanel resolves
 * the global at call time, so installing this after the page has loaded is
 * enough. The stub also keeps the harness's promise that no screenshot run
 * ever calls the live API (CLAUDE.md > Testing): the model is never reached.
 *
 * The lines are the ones app/api/chat/route.ts actually writes, in the order
 * it writes them, so what gets photographed is the panel's own response to the
 * real protocol and not a state poked into it from outside.
 */
async function holdTheAuthoringWait(page: Page, stage: 'spec' | 'mockup'): Promise<void> {
  // PASSED AS SOURCE TEXT, NOT AS A FUNCTION, and that is not a style choice.
  // tsx compiles this file with esbuild, which wraps functions in a `__name`
  // helper to preserve their names. Handing page.evaluate a closure ships that
  // compiled body into the browser, where `__name` does not exist: the stub
  // installs, then throws ReferenceError on the first call. The panel treats a
  // throwing fetch exactly as it treats a dropped connection, so the shot came
  // out showing "interrupted — not saved" instead of the wait — a convincing
  // picture of a screen that does not exist. A string is compiled by nothing.
  const emit =
    stage === 'mockup' ? "send({authoring:true}); send({stage:'mockup'});" : 'send({authoring:true});'
  await page.evaluate(`(function () {
    var real = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = String(input && input.url ? input.url : input);
      if (url.indexOf('/api/chat') === -1) return real(input, init);
      var encoder = new TextEncoder();
      var body = new ReadableStream({
        start: function (controller) {
          function send(value) {
            controller.enqueue(encoder.encode(JSON.stringify(value) + '\\n'));
          }
          // A PARAGRAPH, NOT A LINE, and that is load-bearing. The agent
          // really does answer at this length before it calls the tool, and
          // the reply is the only thing there is to read for the next minute.
          // A one-line fixture fits above the fold whatever the scroller does,
          // so it hides the defect this shot exists to show: the list anchors
          // while the assistant turn is still empty, and a real reply grows
          // straight out of view underneath it. Do not shorten this.
          send({t: 'Got it — that gives me enough to draft something. I am going to build you a single screen with the streak front and centre, a coffee count under it, and nothing else competing for attention. The idea is that one glance in the morning tells you whether yesterday counted.'});
          ${emit}
          // Never closed, and never a {done:true}: the wait is a live state,
          // and holding the stream open is the only way to still one for a
          // camera. It is also exactly what the friend's browser is doing.
        }
      });
      return Promise.resolve(new Response(body, {status: 200}));
    };
  })()`)

  await page.fill('textarea', 'yes, that sounds right — go ahead')
  await page.click('button[type="submit"]')
  // Long enough for the lines to be read and the width transition to land.
  await page.waitForTimeout(1_000)
}

async function performAct(page: Page, act: string): Promise<void> {
  switch (act) {
    case 'collapse-chat':
      await page.getByRole('button', { name: /hide chat/i }).click()
      break
    case 'open-fullscreen':
      await page.getByRole('button', { name: /view full screen/i }).click()
      break
    case 'tab-spec':
      await page.getByRole('tab', { name: /^spec$/i }).click()
      break
    case 'tab-mockup':
      await page.getByRole('tab', { name: /^mockup$/i }).click()
      break
    case 'wait-writing-spec':
    case 'wait-drawing-preview':
      await holdTheAuthoringWait(page, act === 'wait-drawing-preview' ? 'mockup' : 'spec')
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

  // SET IN THIS PROCESS, not only in the server's environment.
  //
  // The seeders below run HERE, and registerFromInvite creates a friend's
  // encrypted database through lib/db/encryptedUserDb.ts, which resolves
  // USERS_DIR at call time. Setting it only on the spawned server left the
  // seeders writing into the repo's own users/ tree — a stray
  // users/<fixture>/<fixture>.db that this file's docstring promises never to
  // create. Caught by tests/users/conventions.test.ts, which swept the stray
  // folder and skipped three checks over it; the harness now sets the variable
  // for itself as well.
  process.env.USERS_DIR = usersDir

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

    // ONE fixture per state per run, not per screen. Several screens share a
    // state — S1 and S2 are both 'invite-valid' — and re-seeding would try to
    // mint a second invite for the same slug, which the UNIQUE constraint
    // rightly refuses. Sharing is also more faithful: a state is a state, and
    // the two screens really are the same friend at two moments.
    const fixtures = new Map<string, Fixture>()

    for (const screen of live) {
      const seed = SEEDERS[screen.state]
      if (!seed) throw new Error(`no seeder for state '${screen.state}' (${screen.id})`)
      if (!fixtures.has(screen.state)) {
        fixtures.set(screen.state, await seed(dbPath, usersDir))
      }
      const fixture = fixtures.get(screen.state)!

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

        if (fixture.password) {
          // The real form, because an unlocked session needs the key put into
          // the SERVER's keymap by the server itself.
          await page.goto(`${ORIGIN}/login`, { waitUntil: 'networkidle' })
          await page.fill('input[name="slug"]', fixture.admin ? 'nico' : (fixture.slug ?? ''))
          await page.fill('input[name="password"]', fixture.password)
          await page.click('button[type="submit"]')
          await page.waitForLoadState('networkidle')
        }

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
