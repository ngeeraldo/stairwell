---
slug: plaidtest
version: 0
---

## What this is for
Proving the shared Plaid connection end to end in a real browser — connect a
bank, refresh it, disconnect it — before any friend's dashboard depends on it.
plaidtest is a scratch account, not a person, and has no spec version behind
it, which is why `version` is 0.

## Screens
One screen, `money`, titled "Money". It carries every panel below; the platform
draws no tab strip for a single screen.

## Panels
**No bank connected.** What the whole screen is replaced by when no connection
exists. Says that connecting runs on the friend's own device and that their
bank login never reaches the server, then offers the Connect control. Which of
the two screens renders is decided by whether a stored connection exists, never
by whether any transactions have arrived — a freshly connected bank has no rows
for the first few seconds while Plaid backfills.

**Accounts.** Each account with its current balance, largest first. A balance
Plaid reports as unknown shows a dash rather than a zero. With a connection but
no accounts yet, says nothing has arrived rather than showing a total.

**Recent transactions.** The most recent dozen: day, merchant, amount, and
whether the charge is still pending. A pending charge is labelled because it
can still change amount or disappear entirely.

**Connection.** Which products this particular bank can serve, the outcome of
the last refresh attempt per product, and the Refresh control. Outcomes have
THREE forms, not two: ok, a failure naming its cause, and "still being prepared"
for a product Plaid holds the connection for but has not finished readying —
routine for recurring streams on the first refresh after connecting. A failure
that only the friend can fix — their bank wanting a fresh login — says so
instead of reading as a fault. Before any refresh has happened it says "never
refreshed" rather than implying the numbers are current.

**Refresh.** The only trigger that exists. A friend's key lives in memory only
while they are unlocked, so nothing can pull on their behalf while they are
away; pressing this is what "fresh" means. It pulls only the products this
connection reports it can serve.

**Reconnect / Disconnect.** Reconnect reopens the same bank for re-login, which
is the only repair when a connection expires — Plaid shows no institution
picker, because the friend is not choosing a bank. It is always available and
never a prompt: nothing in the app knows whether a connection still works, since
that is only discovered when a refresh calls Plaid and is told otherwise, so the
panel says so rather than implying a fault. Disconnect revokes the connection
and destroys the stored credential; it deliberately leaves the synced data in
place, because stopping a connection is reversible and deleting a financial
history is not.

## What can be entered
Nothing is typed in. The only inputs are four controls — connect, reconnect,
disconnect and refresh — each of which posts to a platform route.

## Deliberately not included
Any indication of whether the bank connection is healthy. The item's error state
is only knowable by calling Plaid, and nothing does until the refresh route
exists; showing a guess would be worse than showing nothing.

Any scheduled or automatic refresh: it is not possible, since a friend's key
exists only while they are unlocked. Nothing can reach them when they are not
in the app, so no alert or notification may be promised either.

The two on-demand extraction endpoints (/transactions/refresh,
/investments/refresh): both are fire-and-forget and both are billed per call,
so pressing Refresh would pay four extra seconds for data that arrives on the
NEXT press. Available if a panel ever justifies it.

Multiple banks at once: connecting replaces any existing connection rather than
adding to it. A delete-my-data action separate from disconnect. Any panel
design worth copying — this dashboard exists to exercise the connection, and
what is reviewed here is the plumbing rather than the layout.
