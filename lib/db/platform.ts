import Database from 'better-sqlite3-multiple-ciphers'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { reshapeSacredTables } from './reshape'

export type PlatformDb = Database.Database

const SCHEMA = resolve(process.cwd(), 'platform/schema.sql')

/**
 * Open the platform database at an explicit path and apply the schema.
 *
 * The path is always explicit. There is no ambient default, so a test can
 * never accidentally open the production file, and production can never
 * accidentally open a synthetic one.
 */
export function openPlatformDb(path: string): PlatformDb {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // Before the schema exec, never after: dropping a table drops its triggers,
  // and the exec below is what puts them back. See lib/db/reshape.ts.
  reshapeSacredTables(db)
  db.exec(readFileSync(SCHEMA, 'utf8'))
  return db
}
