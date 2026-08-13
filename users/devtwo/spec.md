# Did I walk the dog today?

<!-- Generated from the confirmed spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** devtwo
- **Spec version:** v1
- **Confirmed:** 2026-08-13T14:11:55.458Z

## Summary

A one-tap daily tracker so I actually walk my dog every day. Tap yes for the day, and see a streak plus what percentage of the last 30 days I managed. Nothing else on it — no bank stuff, no other habits. Started out as a "what's the best time of day to walk based on weather" idea, but the simpler version is the one I want.

## Background

Originally asked for a weather-based dashboard suggesting the best time of day to walk the dog; pivoted to manual logging themselves once weather data turned out to be uncertain. Never said which weather condition they were avoiding (rain vs heat) — the question was asked but overtaken by the pivot. One walk a day counts as enough for them and the dog, so this is a binary yes/no per day rather than a count. Asked directly what rolling window to use for the percentage and accepted the recommendation of 30 days over all-time (all-time gets stuck and stops being informative). Explicitly declined adding anything else, including a bank balance panel — they don't have a morning check-in routine beyond this. No Plaid connection discussed or needed for anything currently specced. Asked repeatedly for the preview, so the visual mockup matters to them.

## Panels

### 1. Walked today?

- **Shows:** A big yes/no state for today's date, with a single tap-to-mark control. One walk marks the day complete.
- **Why:** They wanted the whole thing to be "just a tracker that lets me manually log if I walked my dog today" — and confirmed one walk a day is enough.
- **Source:** manual

### 2. Current streak

- **Shows:** Number of consecutive days walked, ending today or yesterday.
- **Why:** "Streaks is also cool."
- **Source:** derived

### 3. Last 30 days

- **Shows:** Percentage of the last 30 days with a logged walk.
- **Why:** They asked for "a percentage of how many days I do walk my dog", and agreed to a rolling 30-day window rather than all-time so the number keeps moving.
- **Source:** derived

### 4. Last 14 days at a glance

- **Shows:** A row of 14 day markers, filled for walked days and empty for missed ones.
- **Why:** They said yes to seeing "the last couple of weeks at a glance" alongside today's yes/no.
- **Source:** derived

## Manual logging

- One tap per day to mark the dog as walked.

## Open questions

- Can we pull in weather data at all? The original ask was a best-time-of-day-to-walk panel based on weather, and I told them I'd check with Nico rather than guess. Currently not built.
- If weather is possible: they never said what they're trying to avoid — rain, heat, or something else. Would need asking before building anything weather-based.
