export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  return (
    <main>
      <h1>Unlock your data</h1>
      <p>Your password unlocks your data. It is not stored anywhere.</p>
      {error ? <p role="alert">That did not match. Try again.</p> : null}
      <form method="post" action="/api/unlock">
        <label>
          Password{' '}
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <button type="submit">Unlock</button>
      </form>

      {/*
        Without this, a locked session is a dead end. routeFor sends an
        'authenticated' state back here for a deeper path within a user
        space (e.g. /devone/settings) and for anything else that isn't
        /unlock, /admin, or the user's own space page — and the user's own
        space page, while reachable, still withholds its data region until
        unlock. Either way, a user who cannot remember their password has no
        way to reach /login short of clearing the cookie by hand.

        This works while locked because /api/logout is reachable in that
        state: middleware.ts only bounces requests with NO session cookie,
        and app/api/logout/route.ts deliberately does not call requireState.
        It must stay a POST form rather than a link — the handler is
        POST-only, so a GET <a> would 405.
      */}
      <p>Cannot remember it? Sign out and start over.</p>
      <form method="post" action="/api/logout">
        <button type="submit">Sign out</button>
      </form>
    </main>
  )
}
