// tests/copy/onboarding.test.ts
//
// The three copy blocks are build contracts (onboarding-ux-spec.md > Explicit
// constraints). A test that compared a constant to itself would prove nothing,
// so every expectation below is the SPEC's own text, typed out once, here —
// which is what makes a wording change show up as a red test and a decision
// rather than as a quiet diff.
import { describe, expect, it } from 'vitest'
import {
  DEAD_LINK,
  FORGOT,
  NO_RESET_ACK,
  PASSWORD_ERRORS,
  PASSWORD_WARNING,
  PLACEHOLDER_CARD,
  PROMISE_BLOCK,
  WRONG_PASSWORD,
} from '@/lib/copy/onboarding'

describe('the promise block', () => {
  // Two labelled halves as of the 2026-08-14 rewrite (ledger D19), not the
  // three flowing paragraphs the spec handed over.
  it('is exactly two halves — what we see, and what we never see', () => {
    expect(PROMISE_BLOCK.halves).toHaveLength(2)
    expect(PROMISE_BLOCK.halves[0].label).toBe('What we see:')
    expect(PROMISE_BLOCK.halves[1].label).toBe('What we never see:')
  })

  it('discloses that opens are recorded', () => {
    // NOT A COPY TEST. This app records opens — first_session_start,
    // dashboard_write, device class — and CLAUDE.md > Metrics names this
    // promise as the reason that is allowed. Delete the clause and the metrics
    // become undisclosed collection. If this line has to go, the metric rows
    // go with it; that is the trade, and it is why the assertion is here and
    // not in a style guide.
    expect(PROMISE_BLOCK.halves[0].body).toContain('when you open the app')
    expect(PROMISE_BLOCK.halves[0].body).toContain(
      'whether you actually keep using it is the whole experiment',
    )
  })

  it('says the chat is seen, and the data never is', () => {
    // Both halves, because either one alone is a different promise.
    expect(PROMISE_BLOCK.halves[0].body).toContain(
      'everything you tell the AI (your chat history)',
    )
    expect(PROMISE_BLOCK.halves[1].body).toContain('your actual data')
  })

  it('covers data pulled in from elsewhere, not just data typed here', () => {
    // Forward cover for step 6b: Plaid rows land in the same encrypted
    // database under the same key. A friend who reads this before that ships
    // has still been told the truth about it afterwards.
    expect(PROMISE_BLOCK.halves[1].body).toContain(
      'whether created here or pulled in from somewhere else',
    )
  })

  it('states that the encryption is the reason, not a feature', () => {
    expect(PROMISE_BLOCK.halves[1].body).toContain(
      'It’s encrypted with your password, so there’s no way for anyone to access it.',
    )
  })
})

describe('the voice', () => {
  // Nico's ruling, 2026-08-14: every screen speaks as "we". Before that the
  // copy was first-person singular, and the two got mixed on one screen — the
  // promise said "we" while the dead link said "he'll sort it out". Pinned so
  // the next block of copy is written in the voice the rest of them use.
  it('never speaks as "I" where we are the one talking', () => {
    const ours = [
      ...PROMISE_BLOCK.halves.flatMap((h) => [h.label, h.body]),
      PROMISE_BLOCK.heading,
      PASSWORD_WARNING.body,
      PLACEHOLDER_CARD.body,
      DEAD_LINK,
      ...FORGOT.paragraphs,
      ...Object.values(PASSWORD_ERRORS),
    ]
    for (const text of ours) {
      expect(text, `first-person singular in: ${text}`).not.toMatch(
        /\bI\b|\bmy\b|\bme\b/i,
      )
      // The same slip from the other side. "Text Nico and he’ll sort it out"
      // has no "I" in it and was the sentence the first version of this guard
      // waved through — one screen speaking as "we" while another narrates
      // Nico in the third person. Naming him as the person to CONTACT is
      // fine and stays; narrating what he will then do is not.
      expect(text, `third-person narration in: ${text}`).not.toMatch(
        /\bhe\b|\bhis\b/i,
      )
    }
  })

  it('keeps the acknowledgement in the friend’s own voice', () => {
    // The exception, and it is load-bearing: this is the friend telling US
    // what they understand. "We understand there's no reset" is not a consent
    // control. See the comment on NO_RESET_ACK.
    expect(NO_RESET_ACK).toContain('I understand')
    expect(NO_RESET_ACK).toContain('my data is gone')
  })
})

describe('the password warning', () => {
  it('says there is no reset, and what that costs', () => {
    expect(PASSWORD_WARNING.body).toContain('There’s no reset')
    expect(PASSWORD_WARNING.body).toContain(
      'everything you’ve logged is permanently gone and we start over from nothing',
    )
  })

  it('never implies recovery is possible, anywhere a friend can read', () => {
    // The standing constraint: "No password reset path may exist anywhere."
    // That covers the words as much as the routes — an error that says "reset
    // your password" is a promise the system cannot keep.
    const everything = [
      PASSWORD_WARNING.body,
      PASSWORD_WARNING.heading,
      WRONG_PASSWORD,
      NO_RESET_ACK,
      DEAD_LINK,
      ...FORGOT.paragraphs,
      FORGOT.heading,
      ...Object.values(PASSWORD_ERRORS),
    ]
    for (const text of everything) {
      expect(
        text.toLowerCase(),
        `implies recovery: ${text}`,
      ).not.toMatch(/reset your password|recover your (data|password)|reset link|send you a link/)
    }
  })
})

describe('the placeholder card', () => {
  it('points at the chat, and promises no time of day', () => {
    // The spec: "No time promises on the card. Any delivery-time wording
    // anywhere in UI chrome must read from the same two constants as the
    // agent's delivery line — never hardcode a time of day." This block reads
    // from neither constant, so it must contain no timeframe at all.
    expect(PLACEHOLDER_CARD.body).toContain(
      'You’ll hear from the chat when your app is live.',
    )
    expect(PLACEHOLDER_CARD.heading + PLACEHOLDER_CARD.body).not.toMatch(
      /tomorrow|morning|hours|tonight|overnight|minutes/i,
    )
  })
})

describe('the dead link', () => {
  it('says nothing about WHY the link is invalid', () => {
    // "No distinction shown between 'used' and 'unknown' — same message for
    // both (leaks nothing, and the fix is identical: text Nico)."
    expect(DEAD_LINK).toContain('Text Nico')
    expect(DEAD_LINK.toLowerCase()).not.toMatch(/used|expired|unknown|already|revoked/)
  })
})

describe('the wrong-password line', () => {
  it('is the spec’s exact sentence', () => {
    expect(WRONG_PASSWORD).toBe(
      'That password doesn’t unlock your data. Check for typos — caps lock, autocorrect.',
    )
  })
})
