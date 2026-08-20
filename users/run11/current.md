---
slug: run11
version: 2
---

## What this is for
Two questions about the same dog, kept deliberately apart. **Should I take him
out right now, and if not, when?** — answered from a forecast, in one word,
during a break in the work day, and deliberately an answer rather than a
weather report. And **did I take him out?** — a hand-kept record of the days a
walk happened, marked from the laptop later at the desk rather than from a
phone on the way home. The first is pinned to zip 77006 (Montrose, Houston) and
assumes a 40-minute walk: about 0.7 miles out from the house and 0.7 miles
back. The second is entirely what he types in. Neither reads the other.

## Screens
Two, so the platform draws a tab strip.

- **`walk_the_dog`** — "Walk the dog?", order 1. The landing page. Three panels
  stacked: the verdict on top, the next good window under it, and the no-go
  temperature control at the foot. The control is last on purpose — the two
  panels above it are the answer, and a screen that exists to be glanced at
  should not open with a knob.
- **`walk_log`** — "Walk log", order 2. The record of walks taken. The streak
  and the percentage pair up side by side at desktop width and stack at phone
  width; the calendar sits below them, because it is the tallest thing on the
  screen and the two numbers are what the screen is opened to see.

## Panels

### Right now
The verdict, as one of three: **go**, **go but keep it short and shady**, or
**don't go**. Large, first, with a one-line reason under it in small type.

It reads a candidate 40-minute walk starting at a reference minute and runs
three checks over the **whole** walk, not over the instant it starts:

- **Rain** — an hour counts as rain if either its forecast precipitation
  reaches a millimetre threshold **or** its chance of any precipitation reaches
  a percentage threshold. Two signals, because a forecast expresses expectation
  both ways and each misses what the other catches. Any rainy hour the walk
  touches is a no. Not his to set.
- **Heat** — on apparent temperature (feels-like / heat index), never raw
  temperature. At or above **his own no-go number** it is a no; at or above the
  five degrees below that but under it, the middle verdict; below that it is
  fine. The band is derived from the one number he sets and never stored
  separately.
- **Daylight** — the whole walk must sit between sunrise and sunset. The spec
  wrote only the sunset half; sunrise was added because the sunset rule alone
  calls a pre-dawn walk fine. Not his to set.

Decided edges, all of which live in the query rather than the component:

- **Both weather figures are taken at their worst point across the walk**, not
  at its start. A walk spanning two forecast hours is judged by the hotter and
  the wetter of the two.
- **Every failing check is named, not just the first.** Being both too hot and
  about to rain is routine here, and a reason line naming one of them would look
  wrong to anyone who glanced out of a window.
- **A missing sunrise/sunset row counts as dark**, not as fine. An unknown
  sunset is not permission to go out at dusk.
- **If any forecast hour the walk spans is missing, the panel refuses to give a
  verdict** and says the forecast does not cover the next 40 minutes. A verdict
  computed from the hours that happen to be present would most likely be
  missing exactly the hour with the storm in it.
- **The reference minute is the last successful refresh**, not the current
  time — a dashboard is never handed a clock. The panel always prints the time
  its forecast was pulled, so the answer is never presented as more current
  than it is.
- **A forecast from an earlier day suppresses the verdict entirely.** The panel
  says it is out of date rather than answering from stale rows.
- **If the most recent refresh failed but an older one succeeded**, the panel
  keeps showing the older answer with its own timestamp and says plainly that
  the last attempt did not come back. It never blanks over a transient failure
  and never presents the old answer silently.
- **If his no-go number cannot be read, the whole screen fails rather than
  falling back to 90.** Judging the walk against a cutoff he did not choose,
  while the control below shows a different one, is a confident wrong answer —
  which is the failure this panel is built to make impossible. The default is
  for someone who has never set one, not for a read that broke.
- **Empty state**: with no successful refresh ever, it says there is no
  forecast yet and shows the Refresh control. It never shows a verdict invented
  from nothing.

### Next good window
The next stretch of at least 40 continuous minutes clearing all three checks,
given as a start time, how long the window stays open, and **what closes it**.

- **It uses only his no-go number, not the derived shade floor.** A
  short-one-and-shade stretch still counts as a window worth naming. This is
  deliberate and is why it does not simply reuse the verdict.
- **Scanned at a fixed step** (currently ten minutes), which is the precision
  the answer is written in — a minute-by-minute scan would advertise a
  precision an hourly forecast does not have.
- **Today is scanned forward from the reference minute**, floored at sunrise
  and stopping at the last start that still finishes before sunset. If nothing
  qualifies, tomorrow is scanned from its own sunrise. If neither day offers
  one, it says so plainly rather than rendering an empty card.
- **The reason it closes is carried through and displayed** — heat, rain,
  darkness, or the forecast simply running out, which is its own case and is
  not dressed up as weather. Heat and rain are quoted as the actual figure at
  the closing time, not as the configured threshold.
- **A window exactly one scan step wide** says it is the only good start rather
  than offering to head out "any time up to" its own start time. This is a real
  case on a hot day, and the one where the reason matters most.
- **A window already open** says so instead of naming a start time in the past.
- It goes quiet when there is no current forecast, rather than answering from
  stale rows, and it is read behind its own error boundary so a failure here
  cannot take away the verdict above it.

### My no-go temperature
The heat cutoff both panels above are judged against, and the only setting on
this dashboard. A minus and a plus with the number between them, one degree a
press, with the band it implies spelled out underneath: at this number or
hotter it is a no, and the five degrees below it are "go, but short and shady".

- **He sets one number, not two.** Asked directly whether he wanted to set both
  bands, he said "just the hard no number". The shade floor is derived on read
  and never stored — two stored numbers could disagree with each other.
- **Unset means 90°F**, which is what the dashboard hardcoded before this
  existed, so a first load behaves exactly as it did. "Never set" and "set back
  to 90" are deliberately distinguishable: nothing seeds a default row.
- **Bounded to a range**, with the control disabled at each end rather than
  hidden. The range is a guardrail rather than an opinion he expressed: far
  enough down and nothing in a Houston summer clears the check, far enough up
  and nothing fails it, and both ends are a screen that has quietly stopped
  working. The bound is enforced by the write route, not only by the disabled
  button, and a stored value outside it is clamped on read so the number is
  always one the buttons can move.
- **A whole degree, always.** The control cannot produce anything else, so there
  is nothing to validate and nothing to reject.
- It renders in every state of the screen, including before any forecast has
  ever been pulled — he can set his number before the dashboard has anything to
  say.

### Current streak
Consecutive days with a walk marked, counted backwards.

- **A day with no mark yet does not break the run.** If today is marked, the
  run includes today and the panel says so. If it is not, the run is counted
  through yesterday and the panel says *that* — "Through yesterday — today
  isn't marked yet." He marks from his desk later in the day, so this is the
  ordinary case, and a number that silently included today would be claiming a
  walk he has not logged.
- **Zero is a real state and reads differently from an empty log.** With marks
  in the log but none in the last two days, it shows zero and says when the last
  marked day was. With no marks at all it says no walks have been logged yet
  and points at the calendar — never a bare zero that could be mistaken for
  lost history.
- **It stops at a gap**, which is the whole difference between a streak and a
  count, and it crosses month and year boundaries correctly.
- Marks dated after today are ignored rather than counted. None can exist —
  the write route refuses a future day — but a run starting in the future would
  be a number he could not explain.

### Month calendar
One month as a grid, the walked days filled, and the input surface for the
whole screen.

- **Every past square is a control.** Tapping an unmarked day marks it; tapping
  a marked day unmarks it. Back-filling a missed day is the same tap on that
  earlier square, which is half of what the calendar is for.
- **Future days carry no control at all** — plain, dimmed text rather than a
  disabled button, so there is nothing that looks pressable. A mark is a record
  that a walk happened.
- **Today's square is ringed whether or not it is marked**, so "which one is
  today" survives the fill.
- **It opens on the current month and pages backwards** — a rolling twelve
  months, or further back if there are marks there. There is a floor because
  the alternative is paging to 1970 through empty grids, and it is a rolling
  window rather than "back to your first mark" because a brand-new log would
  otherwise be unable to reach last month at all. It never pages forward past
  the current month: every day there is a future day.
- Weeks start on Sunday, with the column headings derived from that one choice
  so they cannot end up pointing at the wrong squares.
- An empty log renders a perfectly ordinary empty calendar — this panel is the
  only way anything gets into the log, so it is never hidden or degraded.

### Days walked
The share of days with a walk marked, as a large percentage, with the
underlying count in words below it.

- **The window is the last 30 days — bounded below by the first day he ever
  marked.** Until the log is that old it reads "N of the M days since you
  started"; afterwards it reads "N of the last 30 days". Days before he had the
  screen are days he could not have marked, and counting them as days he
  skipped would make the number wrong in the one direction that matters at the
  start.
- **The count is shown, not just the percentage.** "18 of 30" and "3 of 5" are
  the same percentage and very different facts.
- **An empty log says there is nothing logged yet**, never 0% — there is no
  denominator to divide by, and a zero would be a claim about days he never had.
- Back-filling an earlier day extends the window backwards, which is correct:
  he has just said he was walking then.

### The two decider panels together
Read from three tables in his own database — forecast hours, per-day
sunrise/sunset, and a log of every refresh attempt — plus the single settings
row holding his no-go number. Every forecast row carries his local day and
local minute-of-day, resolved when it was written. No panel converts an instant
to a local time at read time and none knows a timezone.

### The three walk-log panels together
All three read one table, through one query, once per render — so the streak,
the calendar and the percentage cannot disagree about what is marked. The
streak and the percentage are pure functions of that one list, which is why
there is no per-panel error boundary on this screen: there is no second failure
to isolate, and if the read fails the calendar is gone with them.

The dashboard renders correctly on an empty database, which is what the first
session shows — an empty forecast and an empty log at once.

## What can be entered
Three controls write, all on the friend's own press, each posting to a platform
route which is the only thing holding a writable handle. Every one of them
updates the page in place; the page never navigates.

- **Refresh** (Right now panel, visible in every state including the empty
  one). Pulls a current hourly forecast for the pinned coordinates and replaces
  the stored forecast wholesale, then records the attempt. Every attempt is
  recorded whether or not it succeeded — that record is what lets the panels
  tell a failed refresh from no refresh. Nothing about the account is sent to
  the forecast provider: the request carries coordinates and nothing else, and
  the coordinates are a constant, never a value arriving on a request.
- **− / +** (My no-go temperature). Moves his heat cutoff one degree and
  recomputes both panels above. The request carries a DIRECTION, never a
  number: the new value is computed from the stored one inside a single
  transaction, so two presses cannot each compute from a value the other
  replaced, and the range is enforced by the route rather than by the caller.
  Exactly one settings row exists, ever.
- **A calendar square** (Month calendar). Marks or unmarks that day. The
  request carries the DAY — the only place on this dashboard where a value the
  friend chose is written into the database — validated three ways before it
  goes near a table: the shape of a day key, a real-date round trip, and not in
  the future as judged in his own calendar. Marking the same day twice is one
  fact, not two rows; unmarking a day that is not marked is a no-op, not an
  error. The whole grid goes pending together while a tap is in flight, because
  every square writes the same table and the streak and the percentage move
  with it.

Nothing else is entered anywhere: no duration, no notes, no count of walks
within a day, and nothing typed as free text on either screen.

## Deliberately not included
- **No weather report.** No hourly strip, no chart, no seven-day outlook, no
  temperature displayed for its own sake. The spec asks for something that
  "should read as an answer, not a weather report", and every number on screen
  is there only to justify a verdict or a setting. Adding a forecast display is
  the most obvious-looking improvement here and is the one that was
  specifically turned down.
- **No notification, alert or reminder** — when a good window opens, or to log a
  walk, or for a streak about to break. Not declined on taste: it cannot be
  built. Nothing in this system can reach someone who is not in the app, and the
  data needed to check on their behalf is encrypted under a key that exists only
  while they are logged in. Do not propose it.
- **No second location.** Pinned to 77006. Houston weather is patchy enough
  that the pinning was the point, and no other place was ever mentioned.
- **The walk log and the decider are not joined, and that is a product
  decision, not an oversight.** The log reads nothing from the forecast and the
  decider reads nothing from the log — the spec says so directly. "You walked on
  4 of the 6 days it said don't go" is the obvious next feature and is the one
  to propose out loud rather than slip in: it turns a record of what he did into
  a scoreboard of when he ignored the dashboard.
- **He sets the hard-no number only, not the shade band.** He was asked
  directly whether he wanted to set both and chose one. Do not add a second
  control for the lower band without asking again.
- **Rain and daylight are not tunable.** Only the heat cutoff is his. Nothing
  has ever been said about wanting to walk in the rain or after dark.
- **No adjustment for the individual dog** — age, breed, coat, tolerance. The
  heat cutoff is now his to move, which covers most of what a per-dog model
  would have bought; there is still no notion of the dog itself anywhere in the
  dashboard. Never refused, just never raised.
- **No count of walks within a day, no duration, no notes on a walk.** One walk
  a day is the whole record, stated explicitly in the spec. A day either has a
  walk or it does not.
- **Future days cannot be marked.** A mark is a record that a walk happened.
- **No walk logging from a phone in the moment.** Not blocked — the screen is
  responsive and works at 375px — but it was designed around "mark today's
  square from my laptop mostly", which is why the calendar is the input surface
  rather than a single large button.
- **Nothing else on either screen.** Asked directly whether he wanted anything
  else in this build, the answer was "Nope thats it!" — the same answer he gave
  before v1.
