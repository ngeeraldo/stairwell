---
slug: run11
version: 3
---

## What this is for
Three questions, kept deliberately apart, that happen to belong to the same
person at the same desk. **Should I take the dog out right now, and if not,
when?** — answered from a forecast, in one word, during a break in the work day,
and deliberately an answer rather than a weather report. **Did I take him out?**
— a hand-kept record of the days a walk happened, marked from the laptop later
rather than from a phone on the way home. And **what percentage of my money is
going where?** — a picture of the last month of card and bank spending, checked
about once a week at the laptop, explicitly a picture rather than a budget: he
said outright he does not yet know how he will act on it. The first is pinned to
zip 77006 (Montrose, Houston) and assumes a 40-minute walk: about 0.7 miles out
from the house and 0.7 miles back. The second is entirely what he types in. The
third is synced from two connected accounts, plus the re-filing he does on top
of it. **No two of the three read each other.**

## Screens
Three, so the platform draws a tab strip.

- **`walk_the_dog`** — "Walk the dog?", order 1. The landing page, and it stays
  the landing page. Three panels stacked: the verdict on top, the next good
  window under it, and the no-go temperature control at the foot. The control is
  last on purpose — the two panels above it are the answer, and a screen that
  exists to be glanced at should not open with a knob.
- **`walk_log`** — "Walk log", order 2. The record of walks taken. The streak
  and the percentage pair up side by side at desktop width and stack at phone
  width; the calendar sits below them, because it is the tallest thing on the
  screen and the two numbers are what the screen is opened to see.
- **`spending`** — "Spending", order 3. The pie on top, the transaction list
  under it, and the connection panel at the foot. The list is under the pie
  because it exists mainly so he can re-file things he disagrees with, and the
  pie is what he came for. Desktop-first: it is a weekly read at a laptop, and
  it should be legible in one glance.

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
the dog screens. A minus and a plus with the number between them, one degree a
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

### Where it went
A pie of the last 30 days of spending, one slice per category, with every
category listed beside it carrying its amount and its share of the period.

**No grand total, anywhere.** He asked for one and then corrected himself in the
same conversation — he meant the amount per category. A total is computed as the
denominator of the percentages and is never rendered.

Decided edges, all of which live in the query rather than the component:

- **The window is the last 30 days inclusive of today**, a fixed window with no
  pre-existence bound of the kind "Days walked" carries. That is deliberate and
  the difference is the source: a day before he had the walk-log screen is a day
  he could not have marked, but his bank has no such gap — backfilled data is
  data.
- **Which accounts count is an allow-list**: every credit account, plus every
  depository account whose subtype is `checking` — his credit card and his debit
  card. Savings, CD, money-market, investment and loan accounts are out, because
  transfers between his own accounts would otherwise dominate a spending
  breakdown. **The panel names the accounts it is counting**, so an account
  missing from the picture is visible rather than silent.
- **Amounts are NETTED with their signs, not summed as outflows.** Money coming
  back — a refund, a credit — subtracts from the category it came back from. A
  card payment cancels against itself when both sides are connected: it leaves
  the current account as an outflow and lands on the card as an inflow under the
  same category. Nothing here decides that a category "is not really spending";
  that is his tick box, below.
- **A category is resolved as: his re-filing if he has moved it, else the
  categorisation the transaction arrived with, else an "uncategorised" bucket he
  can see and re-file out of.** The pie and the list read one resolved value
  from one query, so they cannot disagree about where a dollar sits.
- **Every category in the window has a tick box, and unticking one takes it out
  of the pie AND out of the percentages** — the remaining slices rescale.
  Its transactions stay in the list below, and its row stays on screen with its
  amount so he can tick it back.
- **The tick box's default is decided on read, never stored.** A category he has
  never pressed is ticked if it consumed money and unticked if it did not.
  Nothing is written on his behalf, and a category that nets to nothing this
  fortnight and goes positive next month comes back on its own. A choice he
  *did* make survives the amount moving in either direction.
- **A category that nets to zero or less draws no slice even if ticked** — there
  is no zero-width wedge. The tick governs the denominator; the geometry refuses
  it either way. It sits in the list at zero with an empty box, which is what
  makes a refund legible rather than a disappearance.
- **Amounts are rounded to cents before anything compares against zero**, so a
  fraction-of-a-penny float residue cannot decide whether a category appears.
- **Slices are ordered largest first, ties broken by name**, so the order — and
  therefore every slice's colour — is stable between renders.
- **Past seven categories the remainder folds into a neutral "Other" wedge, and
  the panel says how many went into it.** Each folded category still keeps its
  own legend row and its own tick box, so it is combined in the chart and never
  out of reach. With exactly one category over the limit the eighth is simply
  drawn, since an "Other" holding one category hides its name for no gain.
- **The percentages carry a caveat only once he has unticked something that
  would otherwise be in the denominator.** Unticking a category worth nothing
  changes no percentage, so it earns no caveat.
- **Four connection states, and the first two are the ones that get missed.**
  Not connected is decided by whether a connection exists, never by whether
  transactions exist — a freshly connected bank has a token and no rows for
  several seconds. Connected-with-nothing-through says so rather than showing a
  confident zero. A refresh outcome is reported per product, with "still being
  prepared" distinguished from a failure. A bank asking him to log in again is
  named as itself, and is the only condition under which a reconnect control
  appears at all.
- **Nothing drawable renders as host elements and never mounts the chart.** The
  empty-database first render shows an empty state, not an empty circle.

### Transactions
The last 30 days from the same two accounts, newest first, each with its date,
what it was, its amount, and the category it currently sits in.

- **It exists to be re-filed from.** Every row carries a menu of every category
  he can move it into: his own buckets first, then every category his bank has
  ever produced — including ones outside the current window, so a transaction
  re-filed by mistake can always be put back where it came from.
- **A row he has moved says so.** Without that, a category that disagrees with
  his bank's own app would look like the dashboard got it wrong rather than like
  something he did on purpose weeks ago.
- **Dates are relative within the week and absolute beyond it**, with no year —
  the row is already inside a 30-day window.
- **Cents in this list, whole dollars in the pie's legend.** The pie is the
  glance; this is where he reconciles a row against his own memory of it.
- **Money coming back reads with a sign and a colour, never parentheses.**
- **A pending charge is counted and labelled**, because the money has left as
  far as he is concerned but the amount can still change or vanish.
- **A transaction with no merchant name falls back to the raw description**
  rather than reading "unknown" — the bank did say something, and throwing it
  away would lose information he could use to recognise the row.
- **The list is unbounded.** A limit would silently drop transactions the pie
  above is drawn from, and a pie missing its tail is wrong in a way nobody can
  see.
- **Only the category is editable.** Nothing else about a transaction can be
  typed or changed.

### Your connection
What the last refresh did, and the only control that updates any of it.

- **Every refresh attempt is recorded, successful or not**, per product. Without
  that record a failed refresh is indistinguishable from no refresh, and the
  figures above would render as though they were current.
- **Three outcomes, not two.** A product the bank is still preparing is said to
  be still preparing — routine on the first refresh after connecting — rather
  than reported as a failure.
- **It says out loud that the data updates when he presses Refresh and at no
  other time.** Nothing can pull on his behalf while he is away: his data key
  exists only while he is logged in, so there is no scheduled job and there
  cannot be one. This is stated rather than apologised for.

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

### The three spending panels together
The pie and the list are computed from ONE read of one view, so they cannot
disagree about where a dollar sits. The view resolves the account scope and the
category in SQL, so there is no second copy of either rule. Bank data is stored
exactly as it arrived and is never edited: his re-filing and his tick choices
live in his own tables keyed to it, which is what stops a refresh from
trampling them.

The dashboard renders correctly on an empty database, which is what the first
session shows — an empty forecast, an empty log, and no bank connected, at once.

## What can be entered
Seven controls write, all on the friend's own press, each posting to a platform
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
  request carries the DAY — one of only two places on this dashboard where a
  value the friend chose is written into the database — validated three ways
  before it goes near a table: the shape of a day key, a real-date round trip,
  and not in the future as judged in his own calendar. Marking the same day
  twice is one fact, not two rows; unmarking a day that is not marked is a
  no-op, not an error. The whole grid goes pending together while a tap is in
  flight, because every square writes the same table and the streak and the
  percentage move with it.
- **Connect a bank** (Spending, and the reconnect control). Runs on his own
  device; his bank login never reaches this server. Shared platform controls,
  the same ones every finance dashboard uses.
- **Refresh** (Your connection). The only thing that ever updates bank data.
- **Move a transaction** (Transactions). Writes the chosen category against that
  transaction id, in his own table — never as an edit to the synced row, or the
  next refresh would trample it. The transaction must be one he actually has AND
  on an account this screen covers; both are answered by the same check. Moving
  the same transaction twice is one fact and the last choice wins.
- **Add a category** (Transactions). The one free-text value anywhere on this
  dashboard. Trimmed, whitespace-collapsed and length-bounded before it is
  stored, because the name is a primary key and two spellings of one bucket
  would be two rows he cannot tell apart. Typing a name that already exists is a
  no-op rather than an error, in any case.
- **A category's tick box** (the pie's legend). Writes whether that category is
  in the pie. The request names the TARGET state rather than toggling, so a
  double press or a retried request cannot land where neither asked. The
  category must be one he actually has — in use, or a bucket he made.

All four spending controls share one route, so they lock together and settle
together while a write is in flight: the pie and the list are drawn from one
read and must never be seen disagreeing. The two dog-screen routes stay separate
from each other and from this one, for the mirror-image reason.

**Nothing that reaches the unencrypted platform database ever carries a value.**
Not the day, not the temperature, not a category name, not a transaction. Every
write records a slug and a constant panel name and nothing else.

Nothing else is entered anywhere: no walk duration, no notes, no count of walks
within a day, and nothing typed as free text except a category name.

## Deliberately not included
- **No weather report.** No hourly strip, no chart, no seven-day outlook, no
  temperature displayed for its own sake. The spec asks for something that
  "should read as an answer, not a weather report", and every number on that
  screen is there only to justify a verdict or a setting. Adding a forecast
  display is the most obvious-looking improvement there and is the one that was
  specifically turned down.
- **No notification, alert or reminder** — when a good window opens, to log a
  walk, for a streak about to break, or about anything that arrives in his bank.
  Not declined on taste: it cannot be built. Nothing in this system can reach
  someone who is not in the app, and the data needed to check on their behalf is
  encrypted under a key that exists only while they are logged in. Do not
  propose it.
- **No second location.** Pinned to 77006. Houston weather is patchy enough
  that the pinning was the point, and no other place was ever mentioned.
- **The three screens are not joined, and that is a product decision, not an
  oversight.** The log reads nothing from the forecast, the decider reads
  nothing from the log, and spending reads neither. "You walked on 4 of the 6
  days it said don't go" and "you spend more on the days you don't walk" are the
  obvious next features and are the ones to propose out loud rather than slip
  in: they turn a record of what he did into a scoreboard of when he ignored the
  dashboard.
- **He sets the hard-no number only, not the shade band.** He was asked
  directly whether he wanted to set both and chose one. Do not add a second
  control for the lower band without asking again.
- **Rain and daylight are not tunable.** Only the heat cutoff is his. Nothing
  has ever been said about wanting to walk in the rain or after dark.
- **No adjustment for the individual dog** — age, breed, coat, tolerance. The
  heat cutoff is his to move, which covers most of what a per-dog model would
  have bought; there is still no notion of the dog itself anywhere in the
  dashboard. Never refused, just never raised.
- **No count of walks within a day, no duration, no notes on a walk.** One walk
  a day is the whole record, stated explicitly in the spec. A day either has a
  walk or it does not.
- **Future days cannot be marked.** A mark is a record that a walk happened.
- **No walk logging from a phone in the moment.** Not blocked — the screens are
  responsive and work at 375px — but it was designed around "mark today's
  square from my laptop mostly", which is why the calendar is the input surface
  rather than a single large button.
- **No grand total on the spending screen.** He was offered one — a single
  headline "you spent this much in the last 30 days" above the pie — said yes,
  and then said in the same conversation that he had misspoken and meant the
  amount per category. This is a refusal he issued himself, and it is the one
  most likely to be re-proposed by someone reading only the first half of that
  exchange.
- **No trend over time, no month-on-month comparison, no budget line, no
  targets and no alerts on spending.** None was asked for, and he said outright
  he does not yet know how he will act on the picture. It is a picture. Wait
  until he says what he wants to do with it.
- **No split by account.** Both cards are spending sources and the screen covers
  them together. He never asked to see them separately.
- **Nothing about a transaction is editable except its category.** No notes, no
  free text on a row, no correcting an amount or a date. Only the category
  assignment was asked for.
- **No hard-coded rule about which categories "are not really spending".**
  Transfers and card payments are handled by a tick box he controls, not by a
  blocklist the dashboard decides. Deciding on his behalf which of his money
  does not count would be this dashboard forming an opinion about his finances
  that he never asked it to form.
- **No renaming or deleting a custom category.** Not asked for, and a delete
  raises a question nobody has answered — what happens to the transactions filed
  into it.
- **Nothing else on any of the three screens.** Asked directly whether he wanted
  anything else in this build, the answer was "Nope, thats good for now" — the
  same answer he gave before v1 and before v2.
