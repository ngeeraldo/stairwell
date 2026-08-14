// lib/metrics/deviceClass.ts
import { cookies, headers } from 'next/headers'

/**
 * Which kind of screen a metrics row came from.
 *
 * onboarding-ux-spec.md: "the phone-vs-desktop usage split cannot be
 * reconstructed retroactively any more than the retention curve can" — so this
 * exists from user #1, not from whenever someone gets curious.
 *
 * IT IS A FIELD INSIDE metrics.data, NEVER A COLUMN. The spec asks for a
 * column; `metrics` is append-only, trigger-enforced, deliberately outside
 * lib/db/reshape.ts, and holds production rows, so a column is not available
 * and asking for one is asking to break the rule the metrics log exists under
 * (onboarding ledger D4). `json_extract(data, '$.device_class')` is the query.
 *
 * It carries a three-value enum and nothing else, so the permanent policy —
 * metrics never carry user values — is untouched.
 */
export type DeviceClass = 'phone' | 'tablet' | 'desktop'

const CLASSES = new Set<string>(['phone', 'tablet', 'desktop'])

export const DEVICE_CLASS_COOKIE = 'stairwell_dc'

/**
 * The friend's IANA timezone, written by the same inline script.
 *
 * It lives in this module rather than in one of its own because it is the same
 * mechanism — a fact only the client knows, told to the server in a cookie —
 * and splitting them would hide that they are one thing with two payloads.
 * What it is FOR is different, and much less negotiable than a metrics label:
 * the day a tap is filed under (lib/time/dayKey.ts).
 */
export const TIME_ZONE_COOKIE = 'stairwell_tz'

/**
 * The breakpoints, shared by name with the inline script in app/layout.tsx.
 * They are Tailwind's `md` and `lg`, so the class a row reports and the
 * arrangement the shell chose agree with each other.
 */
export const TABLET_MIN_PX = 768
export const DESKTOP_MIN_PX = 1024

/**
 * The cookie wins because it is the only source that has seen a viewport — a
 * Mac at a 400px window is a phone-shaped experience and its User-Agent will
 * never say so. The UA is the fallback for the first request of a session,
 * before any script has run.
 *
 * Both are untrusted, so an unrecognised cookie is DISCARDED rather than
 * written through. An enum in an append-only log is only useful if every row
 * in it is one of the values; one row saying 'laptop' breaks grouping forever.
 */
export function deviceClassFrom(input: {
  cookie: string | undefined
  userAgent: string | undefined
}): DeviceClass {
  if (input.cookie && CLASSES.has(input.cookie)) return input.cookie as DeviceClass

  const ua = input.userAgent ?? ''
  // Tablets first: an Android tablet's UA contains "Android" but NOT "Mobile",
  // which is the only thing separating it from a phone. Checking phones first
  // would need the same negative lookahead anyway, in the harder direction.
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) return 'tablet'
  if (/iPhone|iPod|Android.*Mobile|Mobile Safari|Windows Phone/i.test(ua)) return 'phone'
  return 'desktop'
}

/**
 * The request-scoped read. Server components and route handlers only —
 * `next/headers` throws anywhere else.
 */
export async function readDeviceClass(): Promise<DeviceClass> {
  const cookie = (await cookies()).get(DEVICE_CLASS_COOKIE)?.value
  const userAgent = (await headers()).get('user-agent') ?? undefined
  return deviceClassFrom({ cookie, userAgent })
}

/**
 * The friend's timezone for this request, or `undefined`.
 *
 * `undefined` rather than a defaulted 'UTC', deliberately: `dayKey` already
 * owns the fallback and validates the value, and a default applied twice in
 * two places is a default that can disagree with itself. Callers pass whatever
 * comes back straight through.
 *
 * It CAN be undefined on the very first response of a new session, because the
 * cookie does not exist until the layout's script has run once — the server
 * cannot know a zone before the client has said one. That render falls back to
 * UTC, which is the render where a friend has no logged data at all.
 *
 * THERE IS NO OVERRIDE. The cookie always wins and is re-detected on every
 * page load, so a friend who travels moves to the new zone. That is the right
 * default for a morning-ritual tracker and it is not obviously right for
 * everyone; if a "pin my zone" need ever appears, this function is where it
 * goes — the override first, this cookie as the fallback.
 */
export async function readTimeZone(): Promise<string | undefined> {
  return (await cookies()).get(TIME_ZONE_COOKIE)?.value
}
