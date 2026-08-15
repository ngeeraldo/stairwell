# 200.4 to 190.4 in ten weeks

<!-- Generated from the confirmed spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** run3
- **Spec version:** v1
- **Confirmed:** 2026-08-14T22:35:51.123Z

## What changed

First version. One morning screen with three panels: a 7-day smoothed weight trend plotted against the ten-week pace line from 200.4 to 190.4, a pounds-to-go readout, and the daily weigh-in entry itself. Starting weight 200.4 lb recorded today; target 190.4 lb at week 10.

## Summary

A single morning surface for one goal: getting from 200.4 lb to 190.4 lb over ten weeks starting today. Every morning after stepping off the Withings scale, the weight goes in as one number. The dashboard's job is to keep a jumpy daily number from being the thing that's judged — it shows a smoothed 7-day trend against the roughly-one-pound-a-week pace line, plus how much of the ten pounds is left. It gets read on a phone in the bathroom about half the time and on a laptop over coffee the other half, so it has to work on both.

## Background

Weighs in every morning on a Withings smart scale and believes there's an online Withings portal that might expose the data — worth the builder checking, but the person is genuinely willing to type one number a day, so manual entry is the baseline and any sync is a bonus that shouldn't hold up the build. First instinct was 10 pounds in one week, corrected to 10 weeks unprompted. Explicitly didn't want the raw daily number as the headline — asked for a smoothed trend against pace so a bad day doesn't spook them. No interest expressed so far in food, exercise, or body composition tracking.

## Screens

### `morning` — Morning

#### `trend_vs_pace` — Trend vs pace

- **Intent:**

Am I on the line? Shows the smoothed direction of my weight against the pace I'd need to lose 10 pounds in 10 weeks, so a single bad morning doesn't read as failure.

- **Shows:**

Line chart over the ten-week window: the 7-day rolling average of weigh-ins as the main line, with the straight pace line from 200.4 on day one to 190.4 at week 10 underneath it. Raw daily points shown faintly behind the average. Renders on phone and laptop.

- **When/where:**

Right after weighing in the bathroom on the phone, or later over coffee on a laptop — roughly a 50/50 split.

- **Values:**

- `daily_weight` — entered — One weight in pounds, typed in each morning right after stepping off the Withings scale. A five-second, one-number entry; missed days are allowed and simply leave a gap.
- `weight_7day_avg` — derived — Rolling 7-day mean of the daily weigh-ins, so day-to-day noise is smoothed out.
- `pace_line` — derived — Straight target line from the 200.4 lb starting weight on day one down to 190.4 lb at the end of week 10 — about one pound per week.

#### `pounds_to_go` — Pounds to go

- **Intent:**

How much of the ten pounds is left, and am I ahead of or behind where I should be today?

- **Shows:**

One large number — pounds remaining to 190.4 based on the 7-day average — with a smaller line underneath showing how far above or below the pace line today sits, and how many weeks remain.

- **When/where:**

Glanced at in the same morning check as the trend, on phone or laptop.

- **Values:**

- `remaining_to_goal` — derived — Current 7-day average minus the 190.4 lb goal weight.
- `pace_gap` — derived — Current 7-day average minus the pace line value for today — negative means ahead of pace.
- `weeks_remaining` — derived — Weeks left in the ten-week window from the start date.

#### `weigh_in` — This morning's weigh-in

- **Intent:**

Get today's number in without friction, and confirm it landed.

- **Shows:**

A single number field with a save tap, showing today's entered weight once saved and the change from yesterday beside it. Goal parameters shown small at the bottom: started 200.4 today, target 190.4 at week 10.

- **When/where:**

Phone in the bathroom immediately after stepping off the Withings scale, about five seconds; sometimes backfilled later on a laptop.

- **Values:**

- `start_weight` — entered — Starting weight of 200.4 lb, recorded on day one and fixed thereafter.
- `goal_weight` — entered — Target weight of 190.4 lb.
- `start_date` — entered — The day the ten-week window begins — today, the day of the 200.4 weigh-in.

- **Entry:**

One field each morning: weight in pounds, then one save tap. Date defaults to today but can be changed to backfill a missed morning. — fields: weight_lb (number), date (date)

## Entered by hand

- `daily_weight` — entered — One weight in pounds, typed in each morning right after stepping off the Withings scale. A five-second, one-number entry; missed days are allowed and simply leave a gap.
- `start_weight` — entered — Starting weight of 200.4 lb, recorded on day one and fixed thereafter.
- `goal_weight` — entered — Target weight of 190.4 lb.
- `start_date` — entered — The day the ten-week window begins — today, the day of the 200.4 weigh-in.

## Data requirements

- `daily_weigh_ins` — new — One row per morning: date and weight in pounds, typed in by hand. Feeds the 7-day average and every derived number on the dashboard.
- `weight_goal` — new — Holds the single goal record: start weight 200.4, goal weight 190.4, start date, and ten-week duration — used to draw the pace line.

## Open questions

- Can the builder pull daily weights from the Withings portal or API instead of manual entry? Manual entry is the baseline and shouldn't block the build, but an automatic feed would remove the only daily chore on this dashboard.
- If Withings sync does become possible, should manually typed entries still be allowed as an override for days the scale doesn't report?
