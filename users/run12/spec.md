# run12 — spec v1

<!-- Generated from the spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** run12
- **Spec version:** v1
- **Version date:** 2026-08-22T14:18:14.688Z
- **Based on:** nothing — this is the first version

## What changed

First build: a spending-by-category breakdown covering the rolling last 30 days, shown as a pie chart with each category's share of total spending, pulling from a connected checking account and credit card.

## Changes

### Add screen — Spending Breakdown

The main (and for now only) screen of the dashboard, where Nico lands to see where his money went. He looks at this on a desktop computer in the morning, so it should be laid out for a full browser window rather than a narrow phone screen. Data refreshes only when he presses the refresh button on the dashboard — there is no background sync — so the screen should make it clear when the data was last pulled.

### Add panel — Where my money went (last 30 days)

A pie chart showing spending by category over a rolling 30-day window ending today, not the previous calendar month. Every category is shown — this is not a watchlist of a few chosen categories — and each slice is labelled with the category and its percentage share of total spending for the period. Slices should read biggest to smallest so the largest categories are obvious at a glance. The underlying transactions come from bank data via a connected checking account and a connected credit card, both of which Nico will link; spending from both accounts is combined into one view rather than split per account. Categories come from the transaction data itself. The panel sits on the Spending Breakdown screen as its primary content, and updates when Nico presses refresh.

## Data requirements

_None._

## Open questions

- Nico was asked twice whether the checking account and credit card are at the same bank and did not answer directly, so assume two separate connections may be needed and confirm at link time.
- Category assignment is being taken from whatever the bank/transaction feed provides. If those categories turn out to be too coarse or noisy in practice, Nico may want a way to rename or merge them — not requested, but worth watching once he sees real data.
- Transfers between the checking account and the credit card (for example, card payments) could be double-counted or show up as a spending category. Builder should decide how to exclude internal transfers so the percentages reflect actual spending.
