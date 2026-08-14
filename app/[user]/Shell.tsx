'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

/**
 * S3 — the one composed screen in this product, and the only screen after
 * login.
 *
 * onboarding-ux-spec.md: "one layout for the product's entire life. No
 * first-run special mode, no conditional routing — every login lands here; the
 * only thing that ever changes is what occupies the content area (placeholder
 * card → deployed dashboard)."
 *
 * BREAKPOINTS ARE CSS, NEVER JAVASCRIPT (onboarding ledger D6).
 *
 * The spec's standing rule is "breakpoints change arrangement, never
 * internals", and a matchMedia branch that renders a sheet on narrow and a
 * panel on wide is two implementations of the chat surface wearing one name —
 * it would also render differently on the server than on the client for one
 * frame. So there is ONE chat surface, mounted once, in one DOM position, and
 * Tailwind decides whether its container reads as a fixed left column or a
 * full-screen sheet:
 *
 *   below md — `fixed inset-0`: the chat covers the screen as a sheet.
 *   md and up — `static md:w-[400px] md:border-r`: a fixed-width left panel,
 *   with the content area filling the remainder and reflowing when it closes.
 *
 * The only state is `open`, which means the same thing in both arrangements.
 * It is NOT persisted: onboarding-ux-spec.md lists "persistence of panel state
 * across sessions" as a non-goal, and the default comes from the server
 * instead (see `chatOpenByDefault`). ChatPanel used to keep it in
 * localStorage; that is deleted, because a friend who collapsed the chat once
 * during their interview would otherwise never see it open on the morning
 * their dashboard lands.
 *
 * No resize handle and no animation. Both are non-goals in the same sentence.
 */
export function Shell({
  chat,
  content,
  chatOpenByDefault,
}: {
  chat: React.ReactNode
  content: React.ReactNode
  /**
   * Open until a real dashboard is deployed, collapsed after — the spec's "one
   * boolean". Computed server-side from the dashboard registry, because the
   * client has no way to know and guessing would put the chat over a
   * dashboard on the morning it is supposed to be the point.
   */
  chatOpenByDefault: boolean
}) {
  const [open, setOpen] = useState(chatOpenByDefault)

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      {open ? (
        <aside
          aria-label="Chat"
          data-chat="open"
          className="fixed inset-0 z-20 flex flex-col overflow-y-auto border-border bg-background p-4 md:static md:z-auto md:h-dvh md:w-[400px] md:shrink-0 md:border-r"
        >
          <div className="mb-3 flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Hide chat
            </Button>
          </div>
          <div className="min-h-0 flex-1">{chat}</div>
        </aside>
      ) : (
        // Persistent, and positioned so it is reachable in both arrangements:
        // pinned bottom-right on a phone where the content fills the screen,
        // and in the normal flow at the top of the page on a desktop.
        <div
          data-chat="closed"
          className="fixed right-4 bottom-4 z-20 md:static md:m-4 md:self-start"
        >
          <Button type="button" variant="outline" size="lg" onClick={() => setOpen(true)}>
            Show chat
          </Button>
        </div>
      )}

      <main className="flex-1 overflow-y-auto p-4 md:p-8">{content}</main>
    </div>
  )
}
