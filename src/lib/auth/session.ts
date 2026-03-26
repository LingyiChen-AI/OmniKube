import { db } from '@/lib/db';
import { sessions, users } from '@/lib/db/schema';
import { eq, and, gt } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { cookies } from 'next/headers';

const SESSION_COOKIE = 'k8s_session';
const EXPIRY_HOURS = parseInt(process.env.SESSION_EXPIRY_HOURS || '24');

export async function createSession(userId: string, ipAddress?: string, userAgent?: string) {
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + EXPIRY_HOURS * 60 * 60 * 1000);
  await db.insert(sessions).values({ userId, token, ipAddress, userAgent, expiresAt });
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/', expires: expiresAt,
  });
  return token;
}

export async function validateSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const result = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (result.length === 0) return null;
  const { session, user } = result[0];
  if (!user.isActive) return null;
  return { session, user };
}

export async function deleteSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return;
  await db.delete(sessions).where(eq(sessions.token, token));
  cookieStore.delete(SESSION_COOKIE);
}
