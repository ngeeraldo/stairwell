# run11 — spec v1

<!-- Generated from the spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** run11
- **Spec version:** v1
- **Version date:** 2026-08-20T20:10:25.705Z
- **Based on:** nothing — this is the first version

## What changed

New dog-walk timing screen for 77006 (Montrose) that answers, in one look at the desktop, whether right now is a good time to walk the dog and — if not — when the next good window is today. Verdict is based on rain, heat index, and whether a 40-minute walk finishes before dark.

## Changes

### Add screen — Walk the dog?

A single desktop screen Nico opens during work breaks to decide whether to take the dog out right now. It should read as an answer, not a weather report: the verdict comes first and large, with the reasoning small underneath. Everything on it is pinned to zip 77006 (1900 Mason St, Montrose, Houston) and assumes a 40-minute walk — 0.7 miles out from the house and 0.7 miles back. This is the only screen in the dashboard for now, so it is the landing page.

### Add panel — Right now

The top and largest panel. States plainly whether now is a good time to walk, as one of three verdicts: go, go but keep it short and shady, or don't go. Underneath, a one-line reason naming which condition failed — rain, heat, or darkness. The three checks, evaluated over the next 40 minutes starting now rather than at the current instant: rain (any precipitation expected during the walk is a no); heat index / feels-like temperature (above ~90°F is a no, 85–90°F is the 'short one, shade' middle verdict, below 85°F is fine); and daylight (the walk must finish before sunset, so a start later than 40 minutes before sunset is a no). These thresholds are a starting point Nico picked from my suggestion, not a firm preference — build them so they can be adjusted later once he sees how the dog actually handles it. Fed by a forecast for 77006, not manually entered.

### Add panel — Next good window

Sits directly below the 'Right now' panel and only matters when the verdict is negative, though it can stay visible either way. Shows the next stretch of at least 40 continuous minutes today that clears all three checks — no rain, heat index below 90°F, and finishing before sunset — given as a start time and how long that window stays open (for example, 'from 7:10pm, good until dark'). If no qualifying window remains today, say so directly and give the first one tomorrow morning instead. Same forecast source as the panel above.

## Data requirements

_None._

## Open questions

- Weather is not one of the data sources the dashboard currently draws on — the whole screen depends on getting an hourly forecast for zip 77006 covering precipitation, heat index / feels-like temperature, and sunset time. Builder needs to confirm a forecast source can be wired in, and how often it refreshes, before this is buildable.
- The 90°F / 85°F heat-index cutoffs and the 'finish before sunset' rule are my suggestion, accepted by Nico without a strong opinion. Worth making them easy to tune, and worth revisiting with him after a few weeks of actual use.
