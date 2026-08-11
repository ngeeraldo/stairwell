export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
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
