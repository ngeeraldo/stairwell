# run9 — spec v1

<!-- Generated from the spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** run9
- **Spec version:** v1
- **Version date:** 2026-08-19T20:31:31.804Z
- **Based on:** nothing — this is the first version

## What changed

First build for this account: a pee tracker with a one-tap log button, today's count front and centre, an easy way to correct today's number after a misclick, plus a 7-day daily trend and a weekly average. Works the same on phone and computer.

## Changes

### Add screen — Pee Tracker

The single home surface for this account, and the only screen. It works identically on phone and computer, since Nico logs from both and checks trends from both. Order top to bottom: today's count with the log button, then the correction control, then the daily trend, then the weekly average. Nothing else on it.

### Add screen — Today's count and log button

Sits at the top of the Pee Tracker screen. Shows the number of times logged today as a single large number, and directly beneath it a large, easy-to-hit button that logs one occurrence. Each tap writes a new row with the current timestamp — the time is stored but deliberately not displayed anywhere; Nico said he doesn't need it now and wants it kept for later. The button must be comfortable to hit on a phone one-handed and also work as a plain click on a computer. The count resets with the calendar day.

### Add panel — Fix today's count

A small control just below the log button for correcting misclicks, which Nico expects to happen. It lets him nudge today's number down or up by one. Nudging down removes the most recent logged entry for today; nudging up adds an entry timestamped now, same as a normal tap. It should only ever affect today, and should not be able to take the count below zero.

### Add panel — Daily trend

Below the count, a 7-day view of the daily totals so Nico can see whether today is running high or low against the last week. One value per day, with today included as the most recent point. Computed entirely from the logged entries — nothing typed in here.

### Add panel — Weekly average

At the bottom of the screen, the average number of times per day over the week, giving Nico a baseline to read the daily trend against. Computed from the same logged entries.

## Data requirements

- `pee_logs` — new — One row per logged occurrence, each with a timestamp written automatically at the moment of the tap. Feeds today's count, the daily trend and the weekly average; the correction control adds and deletes rows here. Timestamps are stored but not shown.

## Open questions

_None._
