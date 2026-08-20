#!/usr/bin/env bash
# Scaffold a new user dashboard folder. Run from the repo root:
#   ./scripts/new-dashboard.sh devthree
#
# Creates users/<slug>/ from platform/templates/dashboard/ with the slug
# substituted, then PRINTS the line to add to lib/dashboard/registry.ts.
#
# It does not edit registry.ts. A regex over TypeScript source is a worse
# failure than a one-line paste, and tests/dashboard/registry.test.ts already
# turns a forgotten line into a red suite rather than a blank page.
#
# Templates carry a .tmpl suffix on purpose: a dashboard.tsx full of __SLUG__
# placeholders would be typechecked by Gate C, compiled by `next build`, and
# collected by vitest.
set -euo pipefail

# `[a-z0-9-]` in a bash bracket expression is a COLLATION range, not a
# codepoint range — it is resolved against LC_COLLATE. Measured directly:
# under LC_ALL=C, `case "DEVONE" in *[!a-z0-9-]*)` rejects it as expected;
# under LC_ALL=en_US.UTF-8, the same case ACCEPTS "Devone", "DEVONE" and
# accented input, because that locale's collation order folds case (and
# more) into the range. The repo does not control the droplet's locale, so
# pin it here rather than trust the environment the script happens to run
# in.
export LC_ALL=C

main() {
  local slug="${1:-}"

  # ${1:-} cannot tell an explicitly-empty argument ("") apart from a missing
  # one — both land here as usage, not as an invalid-slug message. Both exit
  # 2 either way, so this is a cosmetic gap, not a validation gap: accepted.
  if [ -z "$slug" ]; then
    echo "usage: ./scripts/new-dashboard.sh <slug>" >&2
    exit 2
  fi

  # The same rule as lib/auth/slug.ts's SLUG_PATTERN: lowercase letters,
  # digits and hyphens, 1-32 characters. Stated here rather than imported
  # because this is bash; tests/scripts/newDashboard.test.ts pins the
  # rejections. The equivalence holds only BECAUSE LC_ALL=C is pinned above —
  # a bracket expression is a collation range, and SLUG_PATTERN's codepoint
  # range has no such dependency.
  case "$slug" in
    *[!a-z0-9-]*)
      echo "invalid slug '$slug': lowercase letters, digits and hyphens only" >&2
      exit 2
      ;;
  esac
  if [ ${#slug} -gt 32 ]; then
    echo "invalid slug '$slug': longer than 32 characters" >&2
    exit 2
  fi

  # Mirrors RESERVED_SLUGS in lib/auth/slug.ts, which lib/auth/accounts.ts
  # already treats as the list of names a slug may never be CREATED as. This
  # script is also a creation-time decision point, so it restates the same
  # list rather than skipping the check — the shell cannot import a
  # TypeScript Set, so this is the same sanctioned duplication as the
  # charset check above. Keep the two lists in step by hand.
  #
  # Only FOUR of these six are live branches here. `_next` and
  # `favicon.ico` contain `_` and `.`, which the charset check above already
  # rejects — this case can never see either one. They are restated anyway
  # so the two lists read the same; tests/auth/accounts.test.ts:88 makes the
  # same point on the TypeScript side.
  case "$slug" in
    admin|login|unlock|api|_next|favicon.ico)
      echo "invalid slug '$slug': reserved for a route" >&2
      exit 2
      ;;
  esac

  local dest="users/$slug"
  if [ -e "$dest" ]; then
    echo "$dest already exists — refusing to overwrite" >&2
    exit 2
  fi

  local src="platform/templates/dashboard"
  if [ ! -d "$src" ]; then
    echo "$src not found — run this from the repo root" >&2
    exit 2
  fi

  mkdir -p "$dest/tests" "$dest/migrations" "$dest/notes"
  local f
  for f in seed.py queries.ts dashboard.tsx; do
    sed "s/__SLUG__/$slug/g" "$src/$f.tmpl" > "$dest/$f"
  done
  # NO 001 AND NO MANIFEST. A scaffold cannot know what shape this friend's
  # dashboard needs, and a placeholder table gets copied rather than replaced —
  # so the folder ships with an empty migrations/ and a README saying what goes
  # in it. The runner treats "no migrations" as nothing to apply, which is
  # correct: their database stays empty until a shape is designed, and their
  # dashboard says so.
  sed "s/__SLUG__/$slug/g" "$src/migrations/README.md.tmpl" \
    > "$dest/migrations/README.md"
  sed "s/__SLUG__/$slug/g" "$src/notes/README.md.tmpl" \
    > "$dest/notes/README.md"
  sed "s/__SLUG__/$slug/g" "$src/tests/dashboard.test.ts.tmpl" \
    > "$dest/tests/dashboard.test.ts"
  # NOT COPIED: platform/templates/dashboard/current.md.tmpl. Same reasoning
  # as "NO 001 AND NO MANIFEST" above — current.md says what the dashboard IS,
  # and a scaffold has no shape yet, so there is nothing true to write. The
  # sweep does not go looking for one either: tests/users/conventions.test.ts's
  # `whenBuilt` checks (which require current.md) are gated on migrations/
  # holding a shape, the same gate this script's own scaffold state skips.
  chmod +x "$dest/seed.py"

  # Deliberately prints only what this script alone knows: the folder it just
  # made, and the registry line for this slug. It does NOT restate the build
  # sequence. It used to, and the copy went stale within two days of the
  # runbook being written — the list here never learned about the <slug>/v<n>
  # branch (so following it landed you on main, which the runbook now names as
  # a thing never to do) and never learned about `npm run shots` (so it skipped
  # the picture review CLAUDE.md requires before a commit).
  # A second copy of a sequence is a second thing to keep true. One pointer is
  # not. tests/scripts/newDashboard.test.ts pins that this stays a pointer.
  #
  # It points at docs/runbook-human.md, not docs/runbook-ai.md: the person
  # reading this terminal is Nico, mid-step-3, and his next moves are step 4
  # (the registry line) and step 5 (pull the spec). The AI build is two steps
  # away and he hands it over from there.
  cat <<MSG

Created $dest

Add this line to DASHBOARDS in lib/dashboard/registry.ts:

     $slug: () => import('@/users/$slug/dashboard'),

Until you do, tests/dashboard/registry.test.ts fails and the page renders
the not-built placeholder.

Next: docs/runbook-human.md, step 4 — it owns the sequence from here.
Do not build on main; step 0 there says why, and this script cannot see
which branch you are on.

MSG
}

main "$@"
