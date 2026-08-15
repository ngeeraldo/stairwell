# Can I walk the dog right now?

<!-- Generated from the confirmed spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** run4
- **Spec version:** v1
- **Confirmed:** 2026-08-15T21:39:13.321Z

## What changed

First version. Two panels on one screen: a go/no-go verdict for right now that has to hold for the full 40-minute walk, and the next 40-minute window when the answer is no. Built on feels-like temperature, rain intensity, and daylight for 77006.

## Summary

A single-answer app for deciding whether to take a 20 lb mini goldendoodle on her usual 40-minute walk within 0.75 miles of 1900 Mason Street, Houston 77006. It answers one question — is right now safe — using feels-like heat and humidity, rain, and daylight, and it only has to be right for the full 40 minutes, not the moment at the door. If the answer is no, it gives the next 40-minute window that works. No day-long planner, no history, no charts.

## Background

Houston summer is the real constraint, so 'no' will be a common and expected answer. The dog is a 20 lb mini goldendoodle — not flat-faced, so some heat tolerance, but pavement in direct sun is the actual risk, which is why a sunny 82°F should read worse than a cloudy 85°F. Heat thresholds came from the agent, not the user: under ~75°F feels-like is fine, 75–85 is shorter/grass-preferred, above ~85 feels-like is wait-it-out; the user confirmed 85 as roughly where their own line sits and stressed humidity matters. They had no pre-existing number in their head and were happy to accept a researched one. Light drizzle is fine; only real rain kills the walk. Dark is an absolute no. Usage is split roughly 50/50 between computer and phone, checked first thing in the morning to plan and again later in the day hopefully if the morning got away from them. They explicitly declined a laid-out view of all the day's windows.

## Screens

### `walk_now` — Walk now?

#### `verdict_now` — Right now

- **Intent:**

Can I take her out right now for our usual 40 minutes? I want one answer, not data to interpret.

- **Shows:**

One large yes/no verdict filling the tile, with a one-line reason underneath when it's a no (too hot, raining, or too dark) and the current feels-like temperature shown small for reference. Verdict is evaluated across the next 40 minutes, not just the current instant.

- **When/where:**

Checked early morning to plan the day, and again later in the day when the morning got away from them. Roughly 50/50 desktop and phone, often standing at the door with the leash.

- **Values:**

- `feels_like_now` — synced — Current and next-40-minute feels-like (heat index) temperature for zip 77006, hourly or finer resolution.
- `precip_now` — synced — Current and next-40-minute precipitation intensity and probability for 77006, with enough granularity to separate light drizzle from real rain.
- `sun_times` — synced — Today's sunrise and sunset times for 77006, used as the hard daylight boundary.
- `cloud_cover_now` — synced — Current and near-term cloud cover / sun intensity for 77006, as a proxy for how hot the pavement is running versus air temperature.
- `walk_verdict` — derived — Yes only if, for every point in the next 40 minutes: feels-like stays at or below the 85°F wait-it-out line (with the line pulled lower in direct sun because pavement runs hotter than air), precipitation stays at or below light drizzle, and the whole 40 minutes falls between sunrise and sunset. Otherwise no, with the first failing condition as the stated reason.
- `walk_length_minutes` — entered — Standard walk length, set once and rarely changed. Currently 40 minutes.
- `heat_thresholds` — entered — The feels-like cutoffs, set once from the researched defaults: fine under 75°F, shorter walk and grass over asphalt 75–85°F, wait it out above 85°F. Adjustable if the line turns out to be wrong in practice.

#### `next_window` — Next good window

- **Intent:**

If now is a no, when is the next time I can actually go out for 40 minutes?

- **Shows:**

A single time range — the start of the next continuous 40-minute stretch that passes all three checks, phrased as a clock time with a relative hint ('6:40 AM, in about 2 hours'). If no window exists before sunset today, it says so and gives tomorrow's first window instead.

- **When/where:**

Read immediately after a 'no' verdict, same sessions and devices as the verdict panel.

- **Values:**

- `feels_like_forecast` — synced — Hourly or finer feels-like (heat index) forecast for 77006 through tomorrow evening.
- `precip_forecast` — synced — Hourly or finer precipitation intensity forecast for 77006 through tomorrow evening.
- `sun_times_forecast` — synced — Sunrise and sunset times for today and tomorrow for 77006.
- `next_good_start` — derived — Scans the forecast forward for the earliest continuous 40-minute stretch that satisfies the same heat, rain, and daylight tests as the current verdict; returns its start time, or tomorrow's first qualifying window if none remains today.

## Entered by hand

- `walk_length_minutes` — entered — Standard walk length, set once and rarely changed. Currently 40 minutes.
- `heat_thresholds` — entered — The feels-like cutoffs, set once from the researched defaults: fine under 75°F, shorter walk and grass over asphalt 75–85°F, wait it out above 85°F. Adjustable if the line turns out to be wrong in practice.

## Data requirements

- `walk_settings` — new — Stores the walk length (40 minutes), the feels-like thresholds (75/85°F), the rain tolerance (light drizzle allowed), and the walk location zip 77006 so the verdict logic has stable inputs.

## Open questions

- Weather is not one of the currently connected shared modules — a forecast source with hourly-or-finer feels-like, precipitation intensity, cloud cover, and sunrise/sunset for zip 77006 needs to be added before either panel can work. Which provider is Nico's call.
- No source gives actual pavement/asphalt surface temperature. The plan is to approximate it by tightening the heat line when cloud cover is low and the sun is high; the builder should confirm that proxy is good enough or propose better.
- Should the 40-minute window check use a hard cutoff at 85°F feels-like, or allow a 'yes, but keep it shorter and stay on grass' middle verdict for the 75–85°F band? The user asked for plain yes/no, so this is currently a hard cutoff.
- In a Houston summer stretch, the next good window may frequently be pre-dawn tomorrow. Confirm that showing tomorrow's first window is the right fallback rather than saying 'nothing today.'
