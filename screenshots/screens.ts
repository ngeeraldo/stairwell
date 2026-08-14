// screenshots/screens.ts
//
// Every screen this branch ships, at the two widths onboarding-ux-spec.md
// names, with what each one has to look like.
//
// THE ASSERTIONS ARE PROSE, DELIBERATELY. They are read against the shot
// before the task that touched that screen is committed (onboarding ledger
// D16). There is no pixel diff here and there should not be: a
// visual-regression suite in a codebase with no baseline fails on every commit
// for a month and then gets switched off. What this catches is the class of
// defect no test in this repo can see — a warning block that does not read as
// a warning, a card that overflows at 375, a mockup preview that is a blank
// white box because its route 404s.
//
// `live` is the whole coordination mechanism. A screen starts false and is
// flipped by the task that builds it, in that task's commit. Until then the
// harness skips it and SAYS SO — tests/scripts/shots.test.ts asserts that
// every live screen has a route file on disk and a seeder that can set its
// state up, so flipping the flag early fails loudly rather than producing a
// 404 screenshot nobody looks at twice.

/** The viewports. onboarding-ux-spec.md: "test every screen at 375px AND 1440px." */
export const WIDTHS = [375, 1440] as const
export type Width = (typeof WIDTHS)[number]

export const VIEWPORT_HEIGHT: Record<Width, number> = { 375: 812, 1440: 900 }

/**
 * The fixture a screen needs before it can be photographed. Each maps to a
 * seeder in scripts/shots.ts, which builds it through the REAL library
 * functions — never hand-written INSERTs, which drift from what the app
 * actually writes and then show a screen no user will ever see.
 */
export type ScreenState =
  | 'anonymous'
  | 'invite-valid'
  | 'invite-used'
  | 'friend-new'
  | 'friend-built'
  | 'friend-locked'
  | 'admin'

/** Something to do after navigating, before the shutter. */
export type ScreenAct =
  | 'open-fullscreen'
  | 'collapse-chat'
  | 'tab-spec'
  | 'tab-mockup'

export type Screen = {
  id: string
  /** Visited after the state is seeded. TOKEN and SLUG are substituted. */
  path: string
  /** The file that must exist for this screen to be reachable. */
  routeFile: string
  state: ScreenState
  act?: ScreenAct
  /** Flipped true by the task that builds this screen. */
  live: boolean
  /** What has to be true of the picture. Read, not asserted. */
  assertions: string[]
}

export const SCREENS: Screen[] = [
  {
    id: 's1-the-deal',
    path: '/invite/TOKEN',
    routeFile: 'app/(auth)/invite/[token]/page.tsx',
    state: 'invite-valid',
    live: true,
    assertions: [
      'One centred card, not bare text floating in an empty viewport (Viewport rules).',
      'At 1440 the card is capped near 420px wide and centred; at 375 it fills the width with page padding.',
      'The greeting reads in Nico’s first-person voice, above the promise block.',
      'All three promise paragraphs are present and legible; none is truncated or clipped.',
      'Exactly one button, reading "Sounds good →". No checkbox anywhere.',
      'No password field — this screen creates nothing.',
    ],
  },
  {
    id: 's2-set-password',
    path: '/invite/TOKEN?step=password',
    routeFile: 'app/(auth)/invite/[token]/page.tsx',
    state: 'invite-valid',
    live: true,
    assertions: [
      'The heading reads "Pick your password".',
      'The warning block is visually distinct — bordered and tinted, destructive/amber, NOT the blue accent. It reads as a warning at a glance, before any word is read.',
      'The warning has the screen to itself above the fields; nothing competes with it.',
      'Two password fields, each with its own Show control, plus the 10+ character hint under the first.',
      'One unchecked checkbox carrying the no-reset acknowledgement.',
      'The "Create my account" button is visibly DISABLED in the empty state.',
      'At 375 nothing overflows horizontally and the warning is fully readable without scrolling sideways.',
    ],
  },
  {
    id: 's0-dead-link',
    path: '/invite/TOKEN',
    routeFile: 'app/(auth)/invite/[token]/page.tsx',
    state: 'invite-used',
    live: true,
    assertions: [
      'One line, one card. No form, no branding effort, no error styling that looks like a crash.',
      'It says to text Nico. It does NOT say whether the link was used or unknown.',
    ],
  },
  {
    id: 's3-shell-placeholder',
    path: '/SLUG',
    routeFile: 'app/[user]/page.tsx',
    state: 'friend-new',
    live: false,
    assertions: [
      'At 1440: chat is a fixed ~400px LEFT panel with a visible divider; the content area fills the remainder and holds the placeholder card.',
      'At 375: the chat covers the screen as a sheet (open by default here — no dashboard is deployed) with a way back to the content.',
      'The placeholder card reads "This is where your app will live." and mentions no time of day.',
      'The chat composer is reachable without scrolling at both widths.',
    ],
  },
  {
    id: 's3-shell-dashboard',
    path: '/SLUG',
    routeFile: 'app/[user]/page.tsx',
    state: 'friend-built',
    live: false,
    assertions: [
      'Chat is COLLAPSED by default here, because a dashboard is deployed — a toggle is visible and the dashboard is the landing view.',
      'The dashboard renders inside the shell, unstyled-by-us and unbroken by it: the shell is platform chrome, not part of the user’s code.',
      'The SYNTHETIC DATA banner is present (this fixture has no real rows) and is not mistakable for chrome.',
    ],
  },
  {
    id: 's3-shell-chat-collapsed',
    path: '/SLUG',
    routeFile: 'app/[user]/page.tsx',
    state: 'friend-new',
    act: 'collapse-chat',
    live: false,
    assertions: [
      'At 1440 the content area REFLOWS to fill the width the panel had; it does not leave a 400px hole.',
      'At 375 the sheet is gone entirely and a persistent toggle remains visible.',
    ],
  },
  {
    id: 's4-login',
    path: '/login',
    routeFile: 'app/(auth)/login/page.tsx',
    state: 'anonymous',
    live: true,
    assertions: [
      'Username, password with a Show control, one primary button.',
      'The promise block is present below the form — the same three paragraphs as S1, verbatim.',
      '"Forgot your password?" is present and unemphatic; it is not styled like a primary action.',
      'One centred card at 1440, capped near 420px; full width with padding at 375.',
    ],
  },
  {
    id: 's4-login-error',
    path: '/login?error=1',
    routeFile: 'app/(auth)/login/page.tsx',
    state: 'anonymous',
    live: true,
    assertions: [
      'The error reads exactly: "That password doesn’t unlock your data. Check for typos — caps lock, autocorrect."',
      'Nothing on screen offers, implies, or links to a reset.',
      'The error reads as information, not as a crash.',
    ],
  },
  {
    id: 's5-forgot',
    path: '/forgot',
    routeFile: 'app/(auth)/forgot/page.tsx',
    state: 'anonymous',
    live: false,
    assertions: [
      'The heading reads "There’s no reset. That’s on purpose."',
      'No form, no input, no email field anywhere on the page.',
      'One control: back to login.',
      'The tone reads as honest rather than as an error state.',
    ],
  },
  {
    id: 'unlock',
    path: '/unlock',
    routeFile: 'app/(auth)/unlock/page.tsx',
    state: 'friend-locked',
    live: true,
    assertions: [
      'Matches the other auth screens — same card, same rhythm. It is not the one screen that looks like it came from a different build.',
      'Both escapes are present: the way to the forgot page and the sign-out form.',
    ],
  },
  {
    id: 'card-proposal',
    path: '/SLUG',
    routeFile: 'app/[user]/page.tsx',
    state: 'friend-new',
    live: false,
    assertions: [
      'Card anatomy, top to bottom: version label, title, one-line description, then the scaled mockup preview, then a COLLAPSED "Details", then the confirm control.',
      'The mockup preview renders actual content — not a blank white box, which is what a broken /mockup route looks like.',
      'The delivery line is present under the buttons.',
      'At 375 the preview scales to the column instead of overflowing it.',
    ],
  },
  {
    id: 'card-fullscreen',
    path: '/SLUG',
    routeFile: 'app/[user]/page.tsx',
    state: 'friend-new',
    act: 'open-fullscreen',
    live: false,
    assertions: [
      'The dialog fills the viewport at both widths, with one close X top-right and nothing else.',
      'The page behind is dimmed and inert; there is no second overlay and no nesting.',
      'The mockup inside is the same document as the card preview, at full width.',
    ],
  },
  {
    id: 'admin-index',
    path: '/admin',
    routeFile: 'app/admin/page.tsx',
    state: 'admin',
    live: false,
    assertions: [
      'A user list with a last-activity timestamp per row, newest first.',
      'An account that has done nothing says so, rather than showing a 1970 date.',
    ],
  },
  {
    id: 'admin-transcript',
    path: '/admin/SLUG',
    routeFile: 'app/admin/[user]/page.tsx',
    state: 'admin',
    live: false,
    assertions: [
      'Reading measure is roughly 680px at 1440 — not the full window width.',
      'User and agent turns are clearly distinguishable at a glance.',
      'A proposal card appears INLINE in conversation order, not collected at the end.',
      'A confirmation appears as an event at the point it happened.',
      'The newest turn is at the bottom and the pane is scrolled to it.',
    ],
  },
  {
    id: 'admin-spec',
    path: '/admin/SLUG',
    routeFile: 'app/admin/[user]/page.tsx',
    state: 'admin',
    act: 'tab-spec',
    live: false,
    assertions: [
      'The spec renders as real markdown — headings are headings, lists are lists. Not a wall of preformatted text.',
      'A version label and a confirmation timestamp sit at the top.',
    ],
  },
  {
    id: 'admin-mockup',
    path: '/admin/SLUG',
    routeFile: 'app/admin/[user]/page.tsx',
    state: 'admin',
    act: 'tab-mockup',
    live: false,
    assertions: [
      'The mockup renders in an iframe with a full-screen control — the same affordance the friend gets.',
      'The iframe shows the mockup itself, not a blank box or an error page: the admin route must be serving it.',
      'Nothing here offers an edit control. The admin portal is read-only.',
    ],
  },
]
