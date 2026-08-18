# Bathroom count

<!-- Generated from the confirmed spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** run8
- **Spec version:** v2
- **Confirmed:** 2026-08-18T20:00:40.117Z

## What changed

First version. One screen with a tap counter for today (plus and minus), and a trend graph over the week that toggles between daily totals and weekly averages.

## Summary

A simple tracker for counting how many times a day I pee. One tap adds to today's count, and a minus button next to it fixes an accidental tap. The main view is a trend over the week, with a toggle to switch to weekly averages instead of daily totals. No timestamps — just the counts. Used on both computer and phone.

## Background

Tracking is intentionally minimal: pee only, no poop split, and no time-of-day or timestamp data — that was considered and turned down. Used on both a computer and a phone, so the tap targets need to work on each. Concerned about mis-taps inflating the count, which is why a subtract control matters. When asked what single number to see first (yesterday's total vs. usual average), the answer was neither — the week's trend is the thing they want to look at, with weekly averages as a toggle rather than a separate tile.

## Screens

### `tracker` — Bathroom count

#### `today_counter` — Today

- **Intent:**

How many times have I peed today? Tap to add one; tap minus to undo an accidental tap.

- **Shows:**

Large current count for today with a plus button and a minus button beside it. The number updates immediately on tap.

- **When/where:**

Throughout the day, on phone when out and on computer when at the desk.

- **Values:**

- `pee_events` — entered — Each pee recorded as one tap of the plus button; a tap of minus removes the most recent one for that day. No timestamp stored beyond the date, so the realistic unit is a per-day count that can go up or down during the day.
- `today_total` — derived — Count of recorded pee events for today's date, net of any subtractions.

- **Entry:**

Two buttons on the tile: plus records one, minus removes one from today. One tap, no confirmation. — fields: delta (number), date (date)

#### `week_trend` — This week

- **Intent:**

What does my count look like across the week, and is my weekly average moving?

- **Shows:**

Line/bar graph of daily totals across the week, with a toggle that switches the same graph to weekly averages over recent weeks.

- **When/where:**

Glanced at when opening the tracker, on computer or phone.

- **Values:**

- `daily_totals` — derived — Net pee count per day, one point per day across the current week.
- `weekly_average` — derived — Average daily count per week, shown as one point per week when the toggle is set to weekly.

## Entered by hand

- `pee_events` — entered — Each pee recorded as one tap of the plus button; a tap of minus removes the most recent one for that day. No timestamp stored beyond the date, so the realistic unit is a per-day count that can go up or down during the day.

## Data requirements

- `pee_events` — new — Stores each recorded pee as a row keyed by date (no time of day), including subtractions, so daily totals and weekly averages can be computed.

## Open questions

- Should minus be allowed to take a day below zero, or stop at zero?
- Can minus only adjust today's count, or should past days be editable too?
- Does the week trend start Monday or Sunday, and how many weeks should the weekly-average view show?
