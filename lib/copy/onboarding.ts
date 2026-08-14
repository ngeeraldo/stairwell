// lib/copy/onboarding.ts
//
// BUILD CONTRACTS. onboarding-ux-spec.md > Explicit constraints for Claude
// Code: "The three copy blocks (promise, password warning, placeholder card)
// are build contracts — shipped verbatim, stored as shared constants."
//
// SHARED, NOT DUPLICATED, and the promise block is why: it appears on two
// surfaces — S1, before an account exists, and S4, because architecture
// -overview.md section 4 requires it "written down where they can see it" —
// and two copies of a promise are two things that can drift apart. Every
// sentence here is pinned by a test, the way today's login promise already is.
// If one stops being true, a red test and a conversation is the right outcome,
// not a silent diff.
//
// APOSTROPHES ARE U+2019 (’), NOT '. Deliberate: it renders correctly in JSX
// without &apos; escaping, and it removes a whole class of vacuous test. The
// unified-loop ledger records one — "a not.toContain that was vacuously true
// because renderToStaticMarkup escapes the apostrophe in 'it'll'".

/**
 * The privacy promise, rendered on S1 (before an account exists) and S4.
 *
 * This wording supersedes the paragraph architecture-overview.md section 4
 * carried — Nico's ruling, 2026-08-14, recorded in
 * docs/superpowers/ledgers/onboarding.md > D19. onboarding-ux-spec.md's S1 was
 * REWRITTEN in the same pass rather than left behind as a superseded draft, so
 * the spec and this constant say the same thing and there is still exactly one
 * copy to check a change against. Three changes, and the reasoning matters more
 * than the words:
 *
 *  - TWO LABELLED HALVES, not three flowing paragraphs. "What we see" /
 *    "What we never see" is the shape a reader can hold, and the shape they
 *    can check us against later.
 *  - THE OPENS DISCLOSURE STAYS, and is the one sentence here that is not
 *    negotiable. This app records opens: `first_session_start`,
 *    `dashboard_write`, device class. CLAUDE.md > Metrics names this promise
 *    as the reason that recording is allowed at all. Delete the clause and the
 *    metrics become undisclosed collection, not telemetry — so the pinned test
 *    for it in tests/copy/onboarding.test.ts is a data-safety gate wearing a
 *    copy test's clothes.
 *  - "WHETHER CREATED HERE OR PULLED IN FROM SOMEWHERE ELSE" is deliberate
 *    forward cover for step 6b: Plaid-sourced rows land in the same encrypted
 *    database under the same key, and a friend reading this before that ships
 *    should already have been told so.
 *
 * The fake-data line and "when the pilot ends, everything is deleted" were
 * dropped in the same ruling. Both remain TRUE — build tools still only ever
 * run on synthetic data (CLAUDE.md > Data safety), and the pilot still ends —
 * they are simply no longer promised on this surface.
 */
export const PROMISE_BLOCK = {
  heading: 'Our Privacy Policy:',
  /**
   * LABEL AND BODY ARE SEPARATE FIELDS, not one sentence starting with a
   * label, because the screenshot review caught the difference: rendered as
   * plain paragraphs, "What we see:" and "What we never see:" sat at body
   * weight in the middle of a run of text, and the two halves read as one
   * grey block. The distinction that matters most on this screen — what we
   * see versus what we never see — was the thing hardest to find on it. The
   * split is what lets each surface put the label on its own line.
   */
  halves: [
    {
      label: 'What we see:',
      body: 'everything you tell the AI (your chat history), and when you open the app — whether you actually keep using it is the whole experiment.',
    },
    {
      label: 'What we never see:',
      body: 'your actual data (whether created here or pulled in from somewhere else). It’s encrypted with your password, so there’s no way for anyone to access it.',
    },
  ],
} as const

/**
 * S2's destruction warning. The spec: "verbatim copy, visually distinct
 * (bordered/tinted), do not soften."
 */
export const PASSWORD_WARNING = {
  heading: 'Read this one properly.',
  body: 'Your data gets locked with this password. There’s no reset — that’s what keeps your data completely secure and completely yours. If you forget it, everything you’ve logged is permanently gone and we start over from nothing.',
} as const

/**
 * What occupies the content area until a dashboard is deployed.
 *
 * Static UI chrome, not an agent message. "You’ll hear from the chat" points
 * at the operator-authored go-live message — the agent never announces its own
 * deploy. And there is NO time of day here: the spec forbids delivery-time
 * wording in chrome that does not read from the same constants as the agent's
 * delivery line, and this reads from none, so it promises none.
 */
export const PLACEHOLDER_CARD = {
  heading: 'This is where your app will live.',
  body: 'Talk to the chat — what it learns is what gets built. You’ll hear from the chat when your app is live.',
} as const

export const GREETING = 'Hey — you’re in.'
export const ACCEPT_BUTTON = 'Sounds good →'

/**
 * S0. One line, and it deliberately does not say WHICH kind of invalid — the
 * spec: "No distinction shown between 'used' and 'unknown' — same message for
 * both (leaks nothing, and the fix is identical: text Nico)."
 */
export const DEAD_LINK =
  'This link isn’t valid anymore. Text Nico and we’ll sort it out.'

export const PASSWORD_MIN_LENGTH = 10
export const PASSWORD_HINT = '10+ characters. A short sentence works great.'
/**
 * STAYS IN THE FIRST PERSON SINGULAR, and is the one string here that does.
 *
 * Everything else on these screens is us talking to the friend, and the
 * 2026-08-14 voice ruling moved all of it to "we". This is the friend talking
 * back — a checkbox they tick to say what THEY understand. "We understand
 * there's no reset" would be us acknowledging our own warning to ourselves,
 * which is not a consent control. Pinned by tests/copy/onboarding.test.ts so a
 * future voice sweep cannot quietly take it.
 */
export const NO_RESET_ACK =
  'I understand there’s no reset — forgotten password means my data is gone.'

export const PASSWORD_ERRORS = {
  mismatch: 'Passwords don’t match.',
  tooShort: 'Needs at least 10 characters.',
  server: 'Something broke on our end — try once more, then text Nico.',
} as const

/**
 * The wrong-password line, S4.
 *
 * The spec gives this one exact-copy treatment and says why: "Never
 * `incorrect password, click here to reset`." An error message that implies
 * recovery exists is the one thing this product cannot say, because there is
 * no recovery and there never will be.
 */
export const WRONG_PASSWORD =
  'That password doesn’t unlock your data. Check for typos — caps lock, autocorrect.'

/** S5. Tell the truth, offer the only real path. No form, no email field. */
export const FORGOT = {
  heading: 'There’s no reset. That’s on purpose.',
  paragraphs: [
    'Your data is encrypted with your password and we never have a copy — that’s what keeps us (and everyone else) out of it. The flip side is that nobody can recover it, including us.',
    'Before giving up: typos, caps lock, and phone autocorrect cause most of these. Try again slowly with the show-password toggle on.',
    'If it’s really gone: text Nico. Your old data gets deleted and you start fresh — same app idea, empty history.',
  ],
  back: '← Back to login',
} as const
