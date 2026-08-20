---
slug: run11
version: 1
---

## What this is for
Deciding whether to take the dog out right now, from a desk, during a break in
the work day. It answers one question — is now a good time, and if not, when —
and it is deliberately an answer rather than a weather report. Everything on it
is pinned to zip 77006 (Montrose, Houston) and assumes a 40-minute walk: about
0.7 miles out from the house and 0.7 miles back.

## Screens
One screen, so the platform draws no tab strip.

- **`walk_the_dog`** — "Walk the dog?", order 1. The landing page and the only
  screen. Holds both panels, stacked: the verdict on top, the next good window
  directly under it.

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
  touches is a no.
- **Heat** — on apparent temperature (feels-like / heat index), never raw
  temperature. At or above the no-go threshold it is a no; at or above the
  lower threshold but below the no-go one it is the middle verdict; below that
  it is fine.
- **Daylight** — the whole walk must sit between sunrise and sunset. The spec
  wrote only the sunset half; sunrise was added because the sunset rule alone
  calls a pre-dawn walk fine.

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
- **Empty state**: with no successful refresh ever, it says there is no
  forecast yet and shows the Refresh control. It never shows a verdict invented
  from nothing.

### Next good window
The next stretch of at least 40 continuous minutes clearing all three checks,
given as a start time, how long the window stays open, and **what closes it**.

- **It uses only the no-go heat threshold, not the middle one.** A
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

### Both panels
Read from three tables in the friend's own database — forecast hours, per-day
sunrise/sunset, and a log of every refresh attempt. Every row carries the
friend's local day and local minute-of-day, resolved when it was written. No
panel converts an instant to a local time at read time and none knows a
timezone.

The dashboard renders correctly on an empty database, which is what the first
session shows until the first refresh lands.

## What can be entered
**Nothing is logged, typed, or recorded by hand.** There is exactly one control
that writes:

- **Refresh** (on the Right now panel, visible in every state including the
  empty one). Pulls a current hourly forecast for the pinned coordinates and
  replaces the stored forecast wholesale, then records the attempt. Both panels
  update in place; the page never navigates. Every attempt is recorded whether
  or not it succeeded — that record is what lets the panels tell a failed
  refresh from no refresh.

The forecast is fetched by a platform route, which is the only thing holding a
writable handle. Nothing about the account is sent to the forecast provider —
the request carries coordinates and nothing else, and the coordinates are a
constant, never a value arriving on a request.

## Deliberately not included
- **No walk logging, no history of walks taken, no streak.** This dashboard
  decides whether to go; it does not record having gone. Nothing was ever asked
  for on that side, and the spec is explicit that the screen is fed by a
  forecast and not manually entered. (Another account's dashboard is a
  walk-logging tracker — these are different products and should not be merged
  on the strength of both involving a dog.)
- **No weather report.** No hourly strip, no chart, no seven-day outlook, no
  temperature displayed for its own sake. The spec asks for something that
  "should read as an answer, not a weather report", and every number on screen
  is there only to justify a verdict. Adding a forecast display is the most
  obvious-looking improvement here and is the one that was specifically turned
  down.
- **No notification, alert or reminder when a good window opens.** Not declined
  on taste — it cannot be built. Nothing in this system can reach someone who
  is not in the app, and the data needed to check on their behalf is encrypted
  under a key that exists only while they are logged in. Do not propose it.
- **No second location.** Pinned to 77006. Houston weather is patchy enough
  that the pinning was the point, and no other place was ever mentioned.
- **No adjustment for the individual dog** — age, breed, coat, tolerance. The
  thresholds are one shared set, tunable in one place. This was not refused so
  much as never raised, and it is the natural next question if the thresholds
  turn out to be wrong.
- **Nothing else on the screen.** Asked directly whether he wanted anything
  else before the build started, the answer was no.
