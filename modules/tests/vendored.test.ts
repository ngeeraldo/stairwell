// modules/tests/vendored.test.ts
//
// THE MODULE IS NEVER FORKED, AND IS NEVER HALF-VENDORED.
//
// modules/plaid/*.sql reaches a friend's folder by `cp` — there is no build
// step, so nothing but this file notices if a copy drifts. The predecessor plan
// deferred this test explicitly (2026-08-20 D5: "revisit when a second finance
// friend exists") on the reasoning that at one friend Nico would spot a hand-
// edited copy. There are two now, and 002_multi_source is the first module
// migration that has to land in a folder that already had the first one.
//
// Two failures are possible and this catches both:
//
//   1. A FORK. A vendored file whose contents differ from the module source.
//      CLAUDE.md forbids this by name — a friend's own needs are met with a
//      LATER migration of their own, as views on top, never by editing the
//      shared copy.
//
//   2. A MISSING MIGRATION. A folder that vendored initial.sql and not
//      002_multi_source.sql. That one is worse than it sounds: the code assumes
//      every plaid_* row carries item_id, so the folder would fail at write
//      time rather than at migrate time, and only for a friend who happened to
//      refresh.
//
// It matches on CONTENT, not on filename, so a folder is free to number its
// copies however its own migration sequence requires — run11 vendored the
// envelope as 003 and this migration as 005, with two of its own in between.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MODULE_DIR = resolve(__dirname, '..', 'plaid')
const USERS_DIR = resolve(__dirname, '..', '..', 'users')

/**
 * Every module migration, in the order it must be applied.
 *
 * Hand-written on purpose. Sorting the directory would put `002_multi_source`
 * before `initial`, and more importantly: adding a file here is the moment
 * someone has to decide whether every finance folder needs it vendored. A list
 * that maintained itself would let a new module migration ship to nobody.
 */
const MODULE_FILES = ['initial.sql', '002_multi_source.sql']

const read = (path: string) => readFileSync(path, 'utf8')

/** Folders that have vendored any part of the Plaid module. */
function financeFolders(): string[] {
  return readdirSync(USERS_DIR).filter((slug) => {
    const migrations = resolve(USERS_DIR, slug, 'migrations')
    return (
      existsSync(migrations) &&
      readdirSync(migrations).some((f) => f.includes('_module_plaid'))
    )
  })
}

const vendoredFiles = (slug: string) => {
  const dir = resolve(USERS_DIR, slug, 'migrations')
  return readdirSync(dir)
    .filter((f) => f.includes('_module_plaid') && f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, sql: read(resolve(dir, f)) }))
}

describe('the shared Plaid module', () => {
  it('has exactly the files this test knows the order of', () => {
    // If this fails, a module migration was added and nobody decided whether
    // the folders below need it. That decision is the point of the failure.
    const onDisk = readdirSync(MODULE_DIR).filter((f) => f.endsWith('.sql')).sort()
    expect(onDisk).toEqual([...MODULE_FILES].sort())
  })

  it('is vendored by at least one folder, or this test proves nothing', () => {
    expect(financeFolders().length).toBeGreaterThan(0)
  })
})

describe.each(financeFolders())('users/%s', (slug) => {
  const sources = MODULE_FILES.map((f) => read(resolve(MODULE_DIR, f)))

  it('has not edited any vendored copy', () => {
    for (const { name, sql } of vendoredFiles(slug)) {
      // Named rather than asserted with a boolean so a failure says WHICH file
      // drifted, in a folder that may have five migrations.
      expect({ name, isModuleSource: sources.includes(sql) }).toEqual({
        name,
        isModuleSource: true,
      })
    }
  })

  it('has vendored every module migration, not just the first', () => {
    const present = vendoredFiles(slug).map((v) => v.sql)
    const missing = MODULE_FILES.filter((f, i) => !present.includes(sources[i]!))
    expect(missing).toEqual([])
  })

  it('applies them in the module\'s own order', () => {
    // 002 ALTERs tables initial.sql creates. A folder that numbered them the
    // other way round would fail at migrate time, on the friend's machine, on
    // an encrypted file nobody can open to see why.
    const order = vendoredFiles(slug).map((v) => sources.indexOf(v.sql))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })
})
