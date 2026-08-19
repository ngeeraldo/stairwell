# devone — reference dashboard

This dashboard is **hand-written as the reference implementation** of the
folder convention in `CLAUDE.md > Dashboard folder conventions`. It is not the
output of an interview and there is no spec behind it.

That is why this folder has no `spec.md`: it is a projection of a spec record,
written by `./scripts/pull-spec.sh <slug>` alongside a gitignored
`conversation.md`, and `devone` has no spec record to project. (`mockup.html`
is gone everywhere — nothing composes or serves mockup HTML any more.) Running
that script here would create the pair; nothing in this folder would be
overwritten.

Copy this folder's shape when building a real dashboard — or better, run
`./scripts/new-dashboard.sh <slug>`, which produces the same shape from
templates.
