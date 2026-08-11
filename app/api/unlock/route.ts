import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/instance'
import { unlock } from '@/lib/auth/flow'
import { SESSION_COOKIE } from '@/lib/session/store'
import { findAccountBySlug } from '@/lib/auth/accounts'
import { readSession } from '@/lib/session/store'

export async function POST(request: Request) {
  const form = await request.formData()
  const password = String(form.get('password') ?? '')
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  if (!sessionId || !(await unlock(getDb(), sessionId, password))) {
    return NextResponse.redirect(new URL('/unlock?error=1', request.url), 303)
  }

  const session = readSession(getDb(), sessionId)!
  const account = getDb()
    .prepare('SELECT slug FROM accounts WHERE id = ?')
    .get(session.account_id) as { slug: string }
  return NextResponse.redirect(new URL(`/${account.slug}`, request.url), 303)
}
