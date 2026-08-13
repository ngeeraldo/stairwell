# devone — reference dashboard

This dashboard is **hand-written as the reference implementation** of the
folder convention in `CLAUDE.md > Dashboard folder conventions`. It is not the
output of an interview and there is no confirmed spec behind it.

That is why this folder has no `spec.md` and no `mockup.html`: those two files
are a projection of a confirmed spec record, written by
`./scripts/pull-spec.sh <slug>`, and `devone` has never confirmed one. Running
that script here would create them; nothing in this folder would be
overwritten.

Copy this folder's shape when building a real dashboard — or better, run
`./scripts/new-dashboard.sh <slug>`, which produces the same shape from
templates.
