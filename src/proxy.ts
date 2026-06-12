import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/login', '/change-password', '/api/auth/login', '/api/auth/send-code', '/api/auth/verify-code', '/api/auth/change-password', '/api/auth/smtp-status'];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) return NextResponse.next();
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) return NextResponse.next();
  const token = req.cookies.get('k8s_session')?.value;
  if (!token) {
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: '未登录' }, { status: 401 });
    // nextUrl.clone() 保留 basePath，new URL('/login', req.url) 会丢失
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
