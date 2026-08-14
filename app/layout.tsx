import './globals.css'

export const metadata = { title: 'Stairwell' }

/**
 * The shell every page renders inside.
 *
 * `shadcn init` wired next/font's Geist here; it was removed in the same task
 * that added it. onboarding-ux-spec.md > Design direction names "Inter or the
 * system-ui stack. One family." — so the family is set once, in
 * app/globals.css, and no font is fetched or self-hosted at all. See the
 * header comment there (onboarding ledger D1a, edit 3).
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/*
          The only script tag in this app.

          It writes a three-value enum into a cookie so server-side metrics
          emitters know what kind of screen a row came from (onboarding ledger
          D4). No user data, no analytics vendor, no network call — the whole
          thing is one assignment.

          Inline and synchronous so the cookie exists before the first metric
          of the session is written; a deferred script would miss the very
          request it is describing. SameSite=Lax and a one-year Max-Age so it
          survives the redirect chain a login is.

          The breakpoints are Tailwind's md and lg, and are named in
          lib/metrics/deviceClass.ts — so the class a row reports and the
          arrangement the shell actually chose agree with each other.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "var w=window.innerWidth,c=w<768?'phone':w<1024?'tablet':'desktop';" +
              "document.cookie='stairwell_dc='+c+';path=/;max-age=31536000;samesite=lax';",
          }}
        />
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  )
}
