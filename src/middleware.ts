import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

const PUBLIC_PATHS = ['/login', '/change-password', '/api/auth/login', '/api/auth/send-code', '/api/auth/verify-code', '/api/auth/change-password'];

function verifyJwtMiddleware(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [header, body, signature] = parts;
    const secret = process.env.ENCRYPTION_KEY || 'k8s-admin-default-jwt-secret';
    const expected = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    if (signature !== expected) return false;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) return NextResponse.next();
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) return NextResponse.next();
  const token = req.cookies.get('k8s_session')?.value;
  if (!token || !verifyJwtMiddleware(token)) {
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: '未登录' }, { status: 401 });
    return NextResponse.redirect(new URL('/login', req.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
