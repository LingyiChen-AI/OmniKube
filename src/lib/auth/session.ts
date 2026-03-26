import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { signJwt, verifyJwt } from './jwt';

const SESSION_COOKIE = 'k8s_session';
const EXPIRY_HOURS = parseInt(process.env.SESSION_EXPIRY_HOURS || '24');

export async function createSession(userId: string, _ipAddress?: string, _userAgent?: string) {
  const expiresAt = Date.now() + EXPIRY_HOURS * 60 * 60 * 1000;
  const token = signJwt({ userId, exp: expiresAt });
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax',
    path: '/', maxAge: EXPIRY_HOURS * 60 * 60,
  });
  return token;
}

export async function validateSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = verifyJwt(token);
  if (!payload) return null;
  const [user] = await db.select().from(users).where(eq(users.id, payload.userId)).limit(1);
  if (!user || !user.isActive) return null;
  return { session: { token }, user };
}

export async function deleteSession() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}
