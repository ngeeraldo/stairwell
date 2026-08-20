# run11 — spec v2

<!-- Generated from the spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** run11
- **Spec version:** v2
- **Version date:** 2026-08-20T21:15:49.284Z
- **Based on:** v1

## What changed

Two additions: you can now set your own no-go feels-like temperature right on the "Walk the dog?" screen, and there's a new "Walk log" screen where you mark off the days you took him out — with a current streak, a month calendar, and a percentage. Adding a second screen means the app now shows a tab strip.

## Changes

### Add panel — My no-go temperature

A small control on the "Walk the dog?" screen letting Nico set the no-go feels-like (heat index) number himself, replacing the currently hardcoded 90°F. He sets only the hard-no number; the middle "go but keep it short and shady" band is always the five degrees directly below whatever he picks (so setting 92 gives a shade band of 87–92). The value is stored in his own database as a single setting and persists between sessions; if nothing has been set yet it defaults to the current 90°F so the screen behaves exactly as it does today on first load. Changing it recomputes both the Right now verdict and the Next good window immediately, in place, with no page navigation. The Next good window panel keeps using only the no-go number and not the shade band, as it does now. All other threshold behaviour is unchanged: heat is still judged on apparent temperature at its worst point across the whole 40-minute walk, and the rain and daylight checks are untouched. This is the only new writable control on the decider screen besides Refresh.

### Change screen — Walk the dog?

Still the landing screen and still pinned to 77006 with the same two panels stacked, verdict on top and next window under it. What changes is that it now also carries the no-go temperature control, and it is no longer the only screen — with the new Walk log screen added, the platform will draw a tab strip. "Walk the dog?" stays first and stays the landing page.

### Add screen — Walk log

A second screen, separate from the decider, for recording that a walk actually happened. Nico marks days from his laptop, usually later at his desk rather than on his phone right after the walk. It holds three things: the current streak of consecutive walked days; a month calendar with walked days marked; and a percentage of days walked. Marking is a single tap on a day's square on the calendar — tapping today's square marks today, and back-filling a missed day is the same tap on that earlier square. Tapping an already-marked day unmarks it, so a mis-tap is recoverable. One walk per day is all that's recorded; there's no count of walks within a day, no duration, and no notes. Everything here is entered by hand — this screen reads nothing from the forecast and shares no data with the decider. It should render sensibly on an empty log: no days marked, streak of zero, and a percentage panel that says there's nothing logged yet rather than showing a misleading zero or dividing by nothing.

### Add panel — Current streak

On the Walk log screen. The number of consecutive days up to and including today that have a walk marked. Reads from the hand-entered walk log. Needs a decided rule for what today means before it has been marked: a day with no mark yet should not break a streak built up through yesterday — show the streak as it stands through yesterday rather than dropping it to zero the moment the day rolls over.

### Add panel — Month calendar

On the Walk log screen. A calendar grid for one month with the walked days visibly marked. This is also the input surface — each square is tappable to mark or unmark that day. Defaults to the current month, with a way to move back to earlier months so past days can be seen and back-filled. Future days should not be markable. Fed entirely by the hand-entered walk log.

### Add panel — Percentage of days walked

On the Walk log screen. The share of days that have a walk marked, shown as a percentage. Computed from the hand-entered walk log. The window it covers needs settling — the last 30 days is the natural reading of what was discussed and matches the "18 of the last 30 days" framing that prompted it, and showing the underlying count alongside the percentage makes it legible. Should say there is nothing logged yet rather than show 0% on an empty log.

## Data requirements

- `walk_log` — new — One row per day Nico marks as walked, entered by hand from the month calendar. Stores his local calendar day. Feeds the streak, the calendar marks, and the percentage. Marking and unmarking add and remove rows.
- `walk_settings` — new — Holds the no-go feels-like temperature Nico sets on the decider screen. A single stored value, defaulting to 90°F when unset; the shade band is derived as the five degrees below it rather than stored separately.

## Open questions

- Confirm the window for the percentage panel — last 30 days, or percentage of the month currently shown on the calendar. Last 30 days is the reading closest to what was discussed, but it was never stated outright.
- Decide how the streak treats today before it has been marked: it should not break a streak built through yesterday, but confirm this is how the builder wants it computed.
- The walk log stores local calendar days entered by hand, while the forecast tables already resolve local day and minute when written. Confirm the two agree on what "today" is so the calendar's today square lines up with the decider's reference day.
