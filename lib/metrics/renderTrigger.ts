import { headers } from 'next/headers'

/**
 * Why a render happened. A render cause, never a user value — see below.
 */
export type RenderTrigger = 'nav' | 'refresh'

/**
 * Distinguish a document load from a router.refresh().
 *
 * WHY THIS EXISTS. `dashboard_open` is written once per render, every render,
 * with no write-path dedup — Nico's ruling: "an open" is a definition applied
 * when the log is READ, never at write time. A tap has ALWAYS produced an
 * open, because the write route answers with a redirect and the browser loads
 * the page again; measured 2026-08-20 against platform/dev/synthetic.db, 38 of
 * 39 dashboard_write rows are followed by a dashboard_open within 3 seconds.
 * Moving to router.refresh() is therefore metric-neutral. This field does not
 * prevent an inflation — it makes an inflation that already exists readable.
 *
 * IT NAMES NO USER VALUE. `nav` and `refresh` are causes of a render, not a
 * panel id, a screen id, a day, a count or a merchant, so CLAUDE.md's metrics
 * bound permits it in this unencrypted table.
 *
 * ADDITIVE BY CONSTRUCTION. `metrics.data` is JSON text, not per-event
 * columns, so this is a key rather than an ALTER TABLE. Rows written before
 * the deploy that introduced it simply lack it, and decode as `nav` by deploy
 * timeline.
 *
 * THE COUPLING, STATED SO IT IS CAUGHT WHERE IT BREAKS. The `rsc` header
 * (Next's own RSC_HEADER, node_modules/next/dist/client/components/app-router-headers.js)
 * rides every app-router client fetch. It means "refresh" HERE only because
 * this app has no client-side navigation at all: the tab strip in
 * app/[user]/page.tsx is deliberately plain `<a href="?screen=">` anchors, no
 * <Link>, no client router. **Introducing a client-side <Link> anywhere under
 * app/[user]/ makes this reader wrong**, and the fallback is read-time
 * correlation with dashboard_write timestamps, which already resolves 38/39.
 */
export async function readRenderTrigger(): Promise<RenderTrigger> {
  return (await headers()).get('rsc') !== null ? 'refresh' : 'nav'
}
