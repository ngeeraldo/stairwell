import { requireState } from '@/lib/session/guard'

// A session that is authenticated or unlocked must not be able to
// re-submit the login form: routeFor sends authenticated sessions to
// /unlock and unlocked sessions to '/' (which itself resolves onward to
// the account's own slug — see app/page.tsx). Without this, an unlocked
// user visiting /login directly (not just via '/') could start a second,
// independent session while the first stayed alive (fix wave, item 5).
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  await requireState('/login')

  const { error } = await searchParams
  return (
    <main>
      <h1>Stairwell</h1>
      {error ? <p role="alert">That did not match. Try again.</p> : null}
      <form method="post" action="/api/login">
        <label>
          Who are you? <input name="slug" autoComplete="username" required />
        </label>
        <label>
          Password{' '}
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <button type="submit">Log in</button>
      </form>
      <p>
        My tools run on fake data. I&apos;ll see what you tell the agent and what
        you ask for. I won&apos;t open your transactions. I&apos;d have to
        deliberately modify the system to see anything, and I won&apos;t.
        Everything&apos;s deleted when the pilot ends.
      </p>
    </main>
  )
}
