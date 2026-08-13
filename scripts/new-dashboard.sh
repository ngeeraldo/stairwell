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

main() {
  local slug="${1:-}"

  if [ -z "$slug" ]; then
    echo "usage: ./scripts/new-dashboard.sh <slug>" >&2
    exit 2
  fi

  # The same rule as lib/auth/slug.ts's SLUG_PATTERN: lowercase letters,
  # digits and hyphens, 1-32 characters. Stated here rather than imported
  # because this is bash; tests/scripts/newDashboard.test.ts pins the
  # rejections.
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

  mkdir -p "$dest/tests"
  local f
  for f in schema.sql seed.py queries.ts dashboard.tsx; do
    sed "s/__SLUG__/$slug/g" "$src/$f.tmpl" > "$dest/$f"
  done
  sed "s/__SLUG__/$slug/g" "$src/tests/dashboard.test.ts.tmpl" \
    > "$dest/tests/dashboard.test.ts"
  chmod +x "$dest/seed.py"

  cat <<MSG

Created $dest

1. Add this line to DASHBOARDS in lib/dashboard/registry.ts:

     $slug: () => import('@/users/$slug/dashboard'),

   Until you do, tests/dashboard/registry.test.ts fails and the page renders
   the not-built placeholder.

2. Generate data and run the new tests:

     npm run synthetic
     npx vitest run users/$slug

3. Build toward users/$slug/mockup.html. Pull the confirmed spec first:

     ./scripts/pull-spec.sh $slug

MSG
}

main "$@"
