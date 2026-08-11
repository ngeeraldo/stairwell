import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db/instance'
import { login } from '@/lib/auth/flow'
import { COOKIE_OPTIONS, SESSION_COOKIE } from '@/lib/session/store'

export async function POST(request: Request) {
  const form = await request.formData()
  const slug = String(form.get('slug') ?? '')
  const password = String(form.get('password') ?? '')

  const sessionId = await login(getDb(), slug, password)
  if (!sessionId) {
    return NextResponse.redirect(new URL('/login?error=1', request.url), 303)
  }

  const response = NextResponse.redirect(new URL('/unlock', request.url), 303)
  response.cookies.set(SESSION_COOKIE, sessionId, COOKIE_OPTIONS)
  return response
}
