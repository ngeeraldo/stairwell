// scripts/export-spec.ts
//
// Prints one account's confirmed spec as JSON on stdout. Runs ON THE
// DROPLET, invoked by scripts/pull-spec.sh over ssh.
//
// THIS READS A NON-SYNTHETIC DATABASE BY DESIGN, on the server, run by Nico.
// That is consistent with CLAUDE.md: the platform database is not encrypted
// with any user key and holds the records Nico is promised access to at
// onboarding. It is NOT consistent with Claude running it locally against
// anything but the synthetic database. This file takes no flag of its own —
// PLATFORM_DB is what selects the database, always explicit, never
// ambient (see lib/db/platform.ts) — so point it at a synthetic one.
// scripts/pull-spec.sh devtwo --local is the only form of this pull an
// agent runs; that script's --local is what passes a synthetic PLATFORM_DB
// through to this file.
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { findAccountBySlug } from '@/lib/auth/accounts'
import { currentSpec } from '@/lib/db/specs'
import { parseSpecPayload } from '@/lib/spec/schema'
import { renderSpecMarkdown } from '@/lib/spec/render'

export function exportSpec(
  db: PlatformDb,
  slug: string,
): { spec_md: string; mockup_html: string } {
  const account = findAccountBySlug(db, slug)
  if (!account) throw new Error(`no account with slug '${slug}'`)

  const spec = currentSpec(db, account.id)
  // Only a CONFIRMED spec is a build contract. Refusing loudly here is what
  // stops a draft being committed as one — an account with proposals but no
  // confirmation must fail, never silently export the newest draft.
  if (!spec) throw new Error(`no confirmed spec for '${slug}'`)

  // parseSpecPayload throws SpecShapeError on a corrupt stored payload. Let
  // it propagate: exportSpec must build BOTH output strings or return
  // NEITHER, never a spec_md from a half-parsed payload paired with a
  // mockup_html from nowhere. Computing spec_md first, before the return
  // object is constructed, is what guarantees that — a throw here means the
  // caller (the CLI entry point below, then pull-spec.sh) never sees a
  // result to write at all.
  const spec_md = renderSpecMarkdown(parseSpecPayload(spec.payload), {
    slug,
    version: spec.version,
    confirmedAt: spec.confirmed_at!,
  })

  return { spec_md, mockup_html: spec.mockup_html }
}

if (process.argv[1]?.endsWith('export-spec.ts')) {
  const slug = process.argv[2]
  if (!slug) {
    console.error('usage: tsx scripts/export-spec.ts <slug>')
    process.exit(2)
  }
  const db = openPlatformDb(
    process.env.PLATFORM_DB ?? 'platform/dev/synthetic.db',
  )
  try {
    // Nothing is written to stdout unless exportSpec returns successfully —
    // an uncaught throw here prints to stderr and exits non-zero, and
    // pull-spec.sh's `set -e` stops before it ever reaches the write step.
    process.stdout.write(JSON.stringify(exportSpec(db, slug)))
  } finally {
    db.close()
  }
}
