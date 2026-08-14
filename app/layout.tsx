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
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  )
}
