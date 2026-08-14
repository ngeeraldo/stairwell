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
 * PANEL WIDTH IS TIERED, and the numbers are not arbitrary. 400px leaves a
 * ~368px measure inside the padding — about forty characters, which is below
 * the 45–75 range prose is comfortable at and reads as a phone column pasted
 * onto a desktop. 600px leaves ~568px, roughly sixty-six characters, the
 * middle of that range. The tier changes at `xl` (1280px) rather than `md`
 * because 1280 is the first width where handing the chat 600px still leaves
 * the content area 680px — a full reading measure of its own. Below that the
 * dashboard would be the one starved, and the dashboard is the point of the
 * morning glance.
 *
 * THE CHAT COLUMN IS CHROME, AND LOG OUT LIVES AT THE BOTTOM OF IT. `footer`
 * is rendered last in that column in BOTH states, so there is one answer to
 * "where is log out" rather than one per arrangement. It used to sit in the
 * content column under the dashboard, where it read as the last row of the
 * friend's own app — a control belonging to the platform, rendered as though
 * it belonged to their data.
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
  footer,
  chatOpenByDefault,
}: {
  chat: React.ReactNode
  content: React.ReactNode
  /**
   * Platform chrome that belongs at the bottom of the chat column — today,
   * the log-out form. A ReactNode rather than something this component
   * renders itself, so the form stays server-rendered in page.tsx and this
   * client component keeps owning only the arrangement.
   */
  footer: React.ReactNode
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
          className="fixed inset-0 z-20 flex flex-col overflow-y-auto border-border bg-background p-4 md:static md:z-auto md:h-dvh md:w-[400px] md:shrink-0 md:border-r xl:w-[600px]"
        >
          <div className="mb-3 flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Hide chat
            </Button>
          </div>
          <div className="min-h-0 flex-1">{chat}</div>
          <div className="mt-3 shrink-0 border-t pt-3">{footer}</div>
        </aside>
      ) : (
        // Persistent, and positioned so it is reachable in both arrangements.
        //
        // ONE DOM ORDER, TWO ARRANGEMENTS, decided in CSS — the same rule the
        // chat surface itself follows (ledger D6). The children are written
        // [toggle, footer]:
        //
        //   below md — `flex-col-reverse items-end`, pinned bottom-right, so
        //   the toggle sits in the thumb corner with log out stacked above it.
        //   md and up — `md:h-dvh md:flex-col md:justify-between`, a full-height
        //   rail: toggle at the top where the panel's header was, log out at
        //   the bottom, which is the same place it is when the chat is open.
        <div
          data-chat="closed"
          className="fixed right-4 bottom-4 z-20 flex flex-col-reverse items-end gap-2 md:static md:h-dvh md:flex-col md:items-start md:justify-between md:p-4"
        >
          <Button type="button" variant="outline" size="lg" onClick={() => setOpen(true)}>
            Show chat
          </Button>
          {footer}
        </div>
      )}

      <main className="flex-1 overflow-y-auto p-4 md:p-8">{content}</main>
    </div>
  )
}
