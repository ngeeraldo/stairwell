# run11 — spec v3

<!-- Generated from the spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** run11
- **Spec version:** v3
- **Version date:** 2026-08-21T20:43:47.506Z
- **Based on:** v2

## What changed

Adding a third screen, "Spending," showing the last 30 days of card and bank transactions grouped into categories as a pie chart, with each slice labelled with its dollar amount and percentage. Below the pie sits the transaction list itself, where any transaction can be moved into a different category, including custom categories he creates. It covers a connected credit card and a connected debit card. There is deliberately no grand total — he asked for it, then corrected himself: he wants the amount per category, not one headline number. Nothing on the two dog screens changes.

## Changes

### Add screen — Spending

A third tab alongside "Walk the dog?" and "Walk log", ordered after them. It answers one question — what percentage of my money is going where — and he said outright he does not yet know how he will act on it, so it is a picture rather than a set of budgets, targets or alerts. He checks it at his laptop about once a week, same desk rhythm as the dog screens, so it is a desktop-first read that should be legible in one glance. It draws on transactions synced from two connected accounts: a credit card and a debit card. Both are spending sources and the screen covers them together rather than separately — he never asked to split by account. The screen is the pie on top and the transaction list under it, because the list exists mainly so he can re-file things he disagrees with.

### Add panel — Where it went

A pie chart of the last 30 days of spending from the connected credit card and debit card, one slice per category. Each slice carries both its dollar amount and its percentage of the period — he explicitly wanted to see amount by category, not just proportions, and the percentage is the thing he came for. Categories come from the transaction data's own categorisation to begin with, but any transaction re-filed by hand in the panel below overrides that, and the pie reflects the re-filing. Deliberately no grand total anywhere: he asked for one, then said in the same conversation that he had misspoken and meant per-category amounts, so a single headline spend figure was dropped on purpose. No trend over time, no month-on-month comparison, no budget line — none of that was asked for and he has not decided what he wants to do with the picture yet. Empty and pre-connection states matter here: before an account is connected there is nothing to draw, and the panel should say what is missing rather than render an empty circle.

### Add panel — Transactions

The last 30 days of transactions from the two connected accounts, listed under the pie, each showing its date, description, amount and the category it currently sits in. Its purpose is re-filing: he can move any transaction into a different category and the change sticks — it survives future syncs and it is what the pie above is drawn from. He can also create his own categories, which then become available to move transactions into and appear as slices once anything is filed there. Only the category assignment is editable; nothing else about a transaction can be typed or changed, and no free text or notes were asked for. When a transaction is re-filed the pie recomputes with it, so the two panels never disagree about where a dollar sits.

## Data requirements

- `transaction_category_overrides` — new — Records the hand-chosen category for a specific synced transaction, overriding whatever the transaction data assigned. Read by both the pie and the list so the re-filing sticks across syncs and renders.
- `custom_categories` — new — The buckets he defines himself, beyond the ones the transaction data produces. Feeds the choices offered when re-filing a transaction and the slices drawn in the pie.

## Open questions

- The card and bank accounts need to be connected before this screen shows anything real — one credit card and one debit card. Worth confirming what the first-load state looks like if only one of the two is connected.
- He hasn't said whether refunds, credits, transfers between his own accounts, or card payments from the debit account should be excluded from the pie. Left as-is for now, but transfers in particular can dominate a spending breakdown and make it read wrong.
