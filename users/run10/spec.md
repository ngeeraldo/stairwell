# run10 — spec v1

<!-- Generated from the spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** run10
- **Spec version:** v1
- **Version date:** 2026-08-20T19:06:50.057Z
- **Based on:** nothing — this is the first version

## What changed

First build for this account: a pee tracker with a big tap-to-log button showing today's running count, and below it a 7-day bar chart with the daily average. Logging happens in the moment from either phone or computer, and the count resets at midnight.

## Changes

### Add screen — Pee Tracker

The single screen for this dashboard, and the only place anything is logged or viewed. It needs to work equally well on phone and on a computer browser, because taps happen in the moment from whichever device is at hand. Top of the screen is the tap button and today's count; below it is the weekly trend.

### Add panel — Today's count

A large, easy-to-hit button that logs one pee per tap, with today's running total shown prominently right there. Every tap writes a timestamped entry by hand — there is no synced source for this. The count covers midnight to midnight and resets to zero at midnight local time; night trips are not expected to be logged, so no early-morning rollover is needed. This is the panel used in the moment, several times a day.

### Add panel — Last 7 days

Sits below the tap button. A bar chart of the daily totals for the last seven days, one bar per day, so the trend over the week is visible at a glance. Alongside it, the daily average across those seven days. Both are computed from the logged taps — nothing is entered separately here. This is the part looked at when glancing at the dashboard rather than logging.

## Data requirements

- `pee_logs` — new — One timestamped row per tap of the log button. Feeds today's running count and, aggregated by calendar day, the 7-day bar chart and daily average.

## Open questions

_None._
