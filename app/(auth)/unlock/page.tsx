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
    </main>
  )
}
