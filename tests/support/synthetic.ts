import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { seedPlatform } from '@/platform/seed'

const REPO = resolve(__dirname, '..', '..')

/**
 * Regenerate the synthetic platform database.
 *
 * The two regenerators below take explicit targets and share no default. A
 * user generator must never write the platform database and vice versa —
 * tests/support/noCross.test.ts asserts both directions.
 */
export function regeneratePlatform(
  targetPath: string = join(REPO, 'platform', 'dev', 'synthetic.db'),
): string {
  mkdirSync(dirname(targetPath), { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${targetPath}${suffix}`, { force: true })
  }
  seedPlatform(targetPath)
  return targetPath
}

/** Regenerate one user's synthetic database by running that user's seed.py. */
export function regenerateUser(
  name: string,
  opts: { root?: string } = {},
): string {
  const root = opts.root ?? REPO
  const seed = join(root, 'users', name, 'seed.py')
  const target = join(root, 'users', name, 'synthetic.db')
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${target}${suffix}`, { force: true })
  }
  execFileSync('python3', [seed, target], { stdio: 'pipe' })
  return target
}
