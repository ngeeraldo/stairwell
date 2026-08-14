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
  it('says my build tools only run on fake data', () => {
    expect(PROMISE_BLOCK.paragraphs[0]).toContain(
      'My build tools only ever run on fake data.',
    )
  })

  it('discloses that engagement is visible and content is not', () => {
    // The engagement half is the sentence the spec folded in from the horizon
    // list, and it is the honest residue of recording opens at all. Both
    // halves are asserted because either one alone is a different promise.
    expect(PROMISE_BLOCK.paragraphs[0]).toContain(
      'when you open the app, because whether you actually keep using it is the whole experiment',
    )
    expect(PROMISE_BLOCK.paragraphs[1]).toContain('What I won’t see: your actual data.')
  })

  it('states that the encryption is the reason, not a feature', () => {
    expect(PROMISE_BLOCK.paragraphs[1]).toContain(
      'there’s no way for me or anyone else to ever access it',
    )
  })

  it('promises deletion at the end of the pilot', () => {
    expect(PROMISE_BLOCK.paragraphs[2]).toBe('When the pilot ends, everything is deleted.')
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
