import type { DashboardModule } from './contract'

/**
 * Slug -> the code that renders that person's dashboard.
 *
 * Deliberately a hand-maintained literal rather than a path built from the URL
 * segment. `import('@/users/' + slug + '/dashboard')` would make a URL segment
 * into a module path — the shape lib/auth/slug.ts exists to prevent — and
 * would build a bundler context over a directory that is empty in a fresh
 * checkout. One line per user is the whole cost, and
 * tests/dashboard/registry.test.ts turns a forgotten line into a red suite.
 *
 * It lives in lib/, not users/, because it is platform code: CLAUDE.md says
 * shared changes happen from the repo root, never inside /users/<name>/. It is
 * also inside a scope the pre-commit gate already guards.
 */
const DASHBOARDS: Record<string, () => Promise<DashboardModule>> = {
  devone: () => import('@/users/devone/dashboard'),
  devtwo: () => import('@/users/devtwo/dashboard'),
}

/**
 * Object.hasOwn, not a bare index. A Record literal inherits Object.prototype,
 * so DASHBOARDS['toString'] returns a FUNCTION — which the page would call as
 * a module loader. Pinned by tests/dashboard/registry.test.ts.
 */
export function dashboardLoaderFor(
  slug: string,
): (() => Promise<DashboardModule>) | undefined {
  return Object.hasOwn(DASHBOARDS, slug) ? DASHBOARDS[slug] : undefined
}

export function registeredSlugs(): string[] {
  return Object.keys(DASHBOARDS)
}
