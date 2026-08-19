'use client'

import { useEffect, useRef } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

/**
 * Transcript / Spec.
 *
 * onboarding-ux-spec.md > Admin portal originally called for a third tab,
 * Mockup, showing the confirmed mockup in an iframe. It is gone as of the
 * mockup-loop removal (plan 2026-08-19-remove-the-mockup-loop, Task 6): the
 * route it read from (app/admin/mockup/[user]/[version]/route.ts) is deleted,
 * and nothing composes or serves mockup HTML any more.
 *
 * Both remaining panes are rendered on the SERVER and passed in as children;
 * this component only decides which is visible. With N=3 friends that costs
 * one extra query per pane per page load, and it keeps the panes server
 * components — which they have to be, because they read the database.
 *
 * NOTHING POLLS. The spec is explicit: "Manual refresh only. No live updates,
 * no polling, no websockets — ntfy is the real-time channel; the portal is for
 * reading." Switching tabs re-renders nothing and fetches nothing.
 */
export function AdminTabs({
  transcript,
  spec,
}: {
  transcript: React.ReactNode
  spec: React.ReactNode
}) {
  return (
    <Tabs defaultValue="transcript" className="w-full">
      <TabsList>
        <TabsTrigger value="transcript">Transcript</TabsTrigger>
        <TabsTrigger value="spec">Spec</TabsTrigger>
      </TabsList>
      {/*
        forceMount on both, for the same reason the proposal card's
        Details block uses it: everything is already rendered server-side, so
        keeping the panes in the DOM costs nothing and makes the whole page
        findable with the browser's own find-in-page. Nico reading a transcript
        and wanting to know whether a phrase appears in the spec should not
        have to guess which tab to look in first.

        Radix marks the inactive ones data-state="inactive"; the class hides
        them.
      */}
      <TabsContent value="transcript" forceMount className="data-[state=inactive]:hidden">
        <ScrolledToBottom>{transcript}</ScrolledToBottom>
      </TabsContent>
      <TabsContent value="spec" forceMount className="data-[state=inactive]:hidden">
        {spec}
      </TabsContent>
    </Tabs>
  )
}

/**
 * The transcript pane, scrolled to the newest turn on mount.
 *
 * The spec: "Newest at bottom, auto-scrolled." The ORDER is the server's job —
 * this only moves the viewport, once, without animation. A conversation that
 * opens at the top means scrolling past three weeks of history to find out
 * what someone said this morning, which is the only thing anyone opens this
 * pane for.
 */
function ScrolledToBottom({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = ref.current
    if (node) node.scrollTop = node.scrollHeight
  }, [])

  return (
    <div ref={ref} data-scrolled-pane className="max-h-[75vh] overflow-y-auto">
      {children}
    </div>
  )
}
