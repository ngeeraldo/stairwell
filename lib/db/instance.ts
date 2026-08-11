import { openPlatformDb, type PlatformDb } from './platform'

let db: PlatformDb | undefined

/**
 * Process-wide platform handle. The path is explicit in production via
 * PLATFORM_DB; the fallback is the synthetic dev database, which is the only
 * database name the guard hook allows locally.
 */
export function getDb(): PlatformDb {
  if (!db) db = openPlatformDb(process.env.PLATFORM_DB ?? 'platform/dev/synthetic.db')
  return db
}
