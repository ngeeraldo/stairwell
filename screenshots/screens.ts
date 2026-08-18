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
  | 'friend-tweak'
  | 'friend-built'
  | 'friend-built-empty'
  | 'friend-locked'
  | 'admin'

/** Something to do after navigating, before the shutter. */
export type ScreenAct =
  | 'open-fullscreen'
  | 'collapse-chat'
  | 'tab-spec'
  | 'tab-mockup'
  // The two halves of the authoring wait. Both send a message and hold the
  // reply open, because the wait exists only mid-turn — see performAct.
  | 'wait-writing-spec'
  | 'wait-drawing-preview'

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
      'The greeting sits above the promise block, and reads warmer than it.',
      'The promise block is headed "Our Privacy Policy:" and both halves are present, legible and unclipped — "What we see" and "What we never see", each reading as its own labelled half rather than one run of text.',
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
    live: true,
    assertions: [
      'At 1440: chat is a fixed ~400px LEFT panel with a visible divider; the content area fills the remainder and holds the placeholder card.',
      'At 375: the chat covers the screen as a sheet (open by default here — no dashboard is deployed) with a way back to the content.',
      'The placeholder card reads "This is where your app will live." and mentions no time of day.',
      'The chat composer is reachable without scrolling at both widths.',
      'User turns and agent turns are distinguishable AT A GLANCE, without reading them: the friend’s messages sit in a LIGHT BLUE bubble on the right, the agent’s are plain full-width text. The blue is unmistakable, not a shade of grey on a grey background.',
      'The agent’s paragraph break is a paragraph break, not a collapsed single space.',
      'At 1440 the chat panel is ~600px, not ~400px — wide enough that the text is not a phone column pasted onto a desktop.',
      'There is NO log out control anywhere on this screen — the chat is open, and log out lives only in the collapsed rail.',
    ],
  },
  {
    id: 's3-shell-dashboard',
    path: '/SLUG',
    routeFile: 'app/[user]/page.tsx',
    state: 'friend-built',
    live: true,
    assertions: [
      'Chat is COLLAPSED by default here, because a dashboard is deployed — a toggle is visible and the dashboard is the landing view.',
      'The dashboard renders inside the shell, unstyled-by-us and unbroken by it: the shell is platform chrome, not part of the user’s code.',
      'The SYNTHETIC DATA banner is present (this fixture runs in dev, where synthetic.db IS the user database) and is not mistakable for chrome.',
      'With the chat collapsed, the left rail holds "Show chat" at the top and "Log out" at the far bottom at 1440; at 375 both sit in the bottom-right corner with the toggle nearest the thumb.',
    ],
  },
  {
    /**
     * THE FIRST SCREEN A FRIEND EVER SEES OF THEIR OWN DASHBOARD.
     *
     * There is no synthetic fallback any more, so the day a dashboard is
     * deployed the friend gets THEIR database — which has nothing in it until
     * they log something. Every dashboard is required to render that state
     * (2026-08-15 migrations design, §9), and a test can only prove it does
     * not throw. Whether it reads as "nothing here yet" or as "something is
     * broken" is a question only a picture answers, which is the whole reason
     * this gate exists (onboarding ledger D16).
     */
    id: 's3-shell-dashboard-empty',
    path: '/SLUG',
    routeFile: 'app/[user]/page.tsx',
    state: 'friend-built-empty',
    live: true,
    assertions: [
      'The dashboard renders. Panels, headings and labels are present — this is not a blank content area and not an error.',
      'Every panel that would show a number or a list says plainly that there is nothing yet, in its own words. No zeroes presented as achievements, no empty chart axes floating unexplained.',
      'Nothing on screen suggests a failure: the words "failed", "error" and "try again" appear nowhere.',
      'No SYNTHETIC DATA banner. This is the friend’s own database and the banner would be a false statement about their history.',
      'Read it as the friend would on their first morning: does this look like a dashboard waiting for data, or like something that broke before they arrived?',
    ],
  },
  {
    id: 's3-shell-chat-collapsed',
    path: '/SLUG',
    routeFile: 'app/[user]/page.tsx',
    state: 'friend-new',
    act: 'collapse-chat',
    live: true,
    assertions: [
      'At 1440 the content area REFLOWS to fill the width the panel had; it does not leave a 600px hole.',
      'At 375 the sheet is gone entirely and a persistent toggle remains visible.',
      'Log out is still reachable with the chat closed, at the bottom of the same rail the toggle is in.',
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
      'The promise block is present below the form — the same two halves as S1, verbatim.',
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
    live: true,
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
    live: true,
    assertions: [
      'Card anatomy, top to bottom: version label, title, one-line description, then the scaled mockup preview, then a COLLAPSED "Details", then the confirm control.',
      'The mockup preview renders actual content — not a blank white box, which is what a broken /mockup route looks like.',
      'The delivery line is present under the buttons.',
      'At 375 the preview scales to the column instead of overflowing it.',
    ],
  },
  {
    // Task 19: the card used to show the friend's ENTIRE dashboard to review a
    // one-word relabel. This is the screen that proves the fix — a friend with
    // an already-confirmed two-screen dashboard (Home, Money) asks for a
    // one-word relabel on Money, and the card that streams back previews ONLY
    // the Money screen, not Home too.
    //
    // WHAT THIS SHOT CANNOT TELL YOU, same caveat as mockup-document just
    // below and for the same reason: the fragment HTML here is the SEED
    // FIXTURE from scripts/shots.ts ('friend-tweak'), not model output — the
    // harness never calls the live API (CLAUDE.md > Testing). This guards the
    // scoping mechanism (composeMockup + affectedScreens, wired through
    // ChatPanel's srcDoc) and the visual result of narrowing it; it cannot
    // prove a real model call scopes correctly, only that a scoped document
    // reaching this component renders as a scoped preview rather than a
    // broken one.
    id: 'card-proposal-scoped',
    path: '/SLUG',
    routeFile: 'app/[user]/ChatPanel.tsx',
    state: 'friend-tweak',
    live: true,
    assertions: [
      'The small preview shows ONLY the Money screen — one panel, "Dining". It does NOT also show the Home screen (the "Streak" panel), which is what the OLD unscoped card would have included.',
      'The panel reads "Dining", not "Eating out" — the just-renamed label, proving this is the NEW version\'s preview and not a stale or cached one.',
      'The card still reads as a complete, presentable mini dashboard on its own — not a cut-off fragment, not blank, not obviously missing something.',
      'At 375 the scoped preview scales to the column the same as any other card (compare against card-proposal).',
      'The "View full screen" control is still present — opening it is a SEPARATE screen (card-fullscreen) that intentionally shows the whole two-screen dashboard, not this scoped view.',
    ],
  },
  {
    // THE SCREEN THAT WAS NEVER PHOTOGRAPHED, and the omission is why a
    // defect survived a gate built for exactly this class of thing.
    //
    // The wait is the longest-lived screen in the product — about a minute,
    // more than any other single view a friend sits in front of — and it had
    // no shot. Every part of it was unit-tested and correct: the server
    // reports both stages, the panel reads them, the sentence changes. What
    // no test in this repo could see was that the bar under the sentence was
    // the same fixed width in both stages, so the thing a person actually
    // watches never moved. Nico read it as a progress bar stuck at a third
    // and never getting to two thirds, which is precisely what it was.
    id: 'wait-writing-spec',
    path: '/SLUG',
    routeFile: 'app/[user]/ChatPanel.tsx',
    state: 'friend-new',
    act: 'wait-writing-spec',
    live: true,
    assertions: [
      'It says "Writing the spec…" — the first half.',
      'THE AGENT\'S REPLY IS READABLE ABOVE THE WAIT, all of it. It is the only thing there is to read for the next minute, and the list anchors while the assistant turn is still empty — so a reply that grew out of view would leave a friend staring at a bar with nothing to do.',
      'The bar is roughly a THIRD of the column and clearly unfinished. Read it as a stranger would: does it look like something in progress, or like something stopped?',
      'The bar sits in a visible track, so its width reads as a position rather than as a floating block of some arbitrary size.',
      'At 375 the bar spans the column without overflowing it.',
    ],
  },
  {
    id: 'wait-drawing-preview',
    path: '/SLUG',
    routeFile: 'app/[user]/ChatPanel.tsx',
    state: 'friend-new',
    act: 'wait-drawing-preview',
    live: true,
    assertions: [
      'It says "Drawing the preview…" — the second and much longer half.',
      'THE BAR IS VISIBLY FURTHER ALONG THAN IN wait-writing-spec. Open the two shots side by side: if the bar is in the same place, the screen is lying about progress for most of a minute, which is the whole reason this pair exists.',
      'It has NOT reached the end. A full bar is a claim that the work is finished.',
    ],
  },
  {
    id: 'card-fullscreen',
    path: '/SLUG',
    routeFile: 'app/[user]/page.tsx',
    state: 'friend-new',
    act: 'open-fullscreen',
    live: true,
    assertions: [
      'The dialog fills the viewport at both widths, with one close X top-right and nothing else.',
      'The page behind is dimmed and inert; there is no second overlay and no nesting.',
      'The mockup inside is the same document as the card preview, at full width.',
      'AT 1440: the mockup uses the width. It is NOT a phone-width column centred in empty space — panels sit beside each other where the content supports it, and prose stays at a readable measure rather than running the full width.',
      'AT 375: the same document reads as a single-column phone dashboard, nothing clipped, no horizontal scroll.',
    ],
  },
  {
    // The mockup document on its own, without the dialog around it — the only
    // shot where a container defect has nowhere to hide. mockup-v1 told the
    // model to render "on a phone-width screen" and got exactly that: a ~430px
    // column centred on a 1440px monitor; mockup-v2 replaces it with a fluid
    // contract.
    //
    // WHAT THIS SHOT CANNOT TELL YOU, stated so nobody over-trusts it: the
    // HTML here is the SEED FIXTURE from scripts/shots.ts, not model output.
    // The harness never calls the live API (CLAUDE.md > Testing), so no
    // screenshot in this repo can verify that the model obeys mockup-v2. This
    // guards the route, the iframe, and the fixture's own responsiveness — a
    // real container regression in generated HTML shows up only in a live
    // walkthrough, or in a mockup pulled by scripts/pull-spec.sh and opened by
    // hand. Read the assertions below as "what a correct document looks like",
    // and check them against a REAL generated mockup at least once per prompt
    // version.
    id: 'mockup-document',
    path: '/mockup/1',
    routeFile: 'app/mockup/[version]/route.ts',
    state: 'friend-new',
    live: true,
    assertions: [
      'AT 1440 the layout is composed for the width — several panels across where the content allows, not one narrow column with empty margins either side.',
      'AT 1440 no line of prose runs the entire window width; measure stays readable.',
      'AT 375 it is a single comfortable column: nothing clipped, no horizontal scrolling.',
      'It is ONE document behaving differently at the two widths — not two different layouts and not a fixed-width card.',
      'No annotation furniture: no "also appears as", no "other one-line answers this shows", no caption explaining what a panel is for. Panels show data, not commentary about themselves.',
      'Every value is loudly fake (TEST merchants, £000.00) — nothing that could be mistaken for real money.',
    ],
  },
  {
    id: 'admin-index',
    path: '/admin',
    routeFile: 'app/admin/page.tsx',
    state: 'admin',
    live: true,
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
    live: true,
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
    live: true,
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
    live: true,
    assertions: [
      'The mockup renders in an iframe with a full-screen control — the same affordance the friend gets.',
      'The iframe shows the mockup itself, not a blank box or an error page: the admin route must be serving it.',
      'Nothing here offers an edit control. The admin portal is read-only.',
    ],
  },
]
