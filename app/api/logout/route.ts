import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/instance'
import { relativeRedirect } from '@/lib/http/redirect'
import { SESSION_COOKIE, destroySession } from '@/lib/session/store'

export async function POST() {
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value
  if (sessionId) destroySession(getDb(), sessionId)
  const response = relativeRedirect('/login')
  response.cookies.delete(SESSION_COOKIE)
  return response
}
