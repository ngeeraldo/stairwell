import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE, destroySession } from '@/lib/session/store'

export async function POST(request: Request) {
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value
  if (sessionId) destroySession(getDb(), sessionId)
  const response = NextResponse.redirect(new URL('/login', request.url), 303)
  response.cookies.delete(SESSION_COOKIE)
  return response
}
