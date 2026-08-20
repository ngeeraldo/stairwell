# Build notes for run10

One file per confirmed spec version that was **built**: `v1.md`, `v2.md`, …

**Added, never edited.** `scripts/announce-deploy.ts` speaks from this file;
editing one afterwards changes what an already-sent, permanently stored
announcement was based on.

**Never put run10's data in here.** This folder is committed to the repo.
Describe the shape of what was built — a table, a panel, a computation — never
a row, a value, or a merchant. Same bound `metrics` already carries.

Two sections reach run10 and two do not. `lib/build/notes.ts` enforces that
split; nothing you write in the wrong section gets rescued by a prompt.

```markdown
---
slug: run10
version: 1
built_at: YYYY-MM-DD
---

## What shipped
Product-level. What run10 can now see or do that they could not before.
FRIEND-FACING. Must not be empty.

## Built differently
In-spirit adjustments: where the build's shape differs from how the spec
described it, and why it works better this way. FRIEND-FACING. Empty is
normal and correct — most builds have no adjustment worth mentioning.

## Open
Anything in the confirmed spec that did NOT land. BUILDER-ONLY, and a routing
instruction rather than a disclosure: it never reaches run10. Take it back
to the chat — `scripts/ask-user.ts` for a decision only they can make, a new
proposal for anything that cannot be built as agreed. `announce-deploy.ts`
warns you when this section is non-empty.

## Notes for the next build
Technical residue: what is fragile, why a structure is the way it is, what a
future version should not assume. BUILDER-ONLY.
```
