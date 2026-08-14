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
 * This wording SUPERSEDES the paragraph architecture-overview.md section 4
 * carried and app/(auth)/login/page.tsx used to hard-code: the spec says so in
 * as many words, and it folds the engagement-visibility disclosure into the
 * first paragraph rather than leaving it as a separate sentence.
 */
export const PROMISE_BLOCK = {
  heading: 'The deal, honestly:',
  paragraphs: [
    'My build tools only ever run on fake data. What I will see: everything you tell the AI, everything you ask it for — that’s how your app gets built — and when you open the app, because whether you actually keep using it is the whole experiment.',
    'What I won’t see: your actual data. It’s encrypted with a password only you know — there’s no way for me or anyone else to ever access it.',
    'When the pilot ends, everything is deleted.',
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
  'This link isn’t valid anymore. Text Nico and he’ll sort it out.'

export const PASSWORD_MIN_LENGTH = 10
export const PASSWORD_HINT = '10+ characters. A short sentence works great.'
export const NO_RESET_ACK =
  'I understand there’s no reset — forgotten password means my data is gone.'

export const PASSWORD_ERRORS = {
  mismatch: 'Passwords don’t match.',
  tooShort: 'Needs at least 10 characters.',
  server: 'Something broke on my end — try once more, then text Nico.',
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
    'Your data is encrypted with your password and I never have a copy — that’s what keeps me (and everyone else) out of it. The flip side is that nobody can recover it, including me.',
    'Before giving up: typos, caps lock, and phone autocorrect cause most of these. Try again slowly with the show-password toggle on.',
    'If it’s really gone: text Nico. Your old data gets deleted and you start fresh — same app idea, empty history.',
  ],
  back: '← Back to login',
} as const
