import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Result } from 'antd';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/auth';
import type { GlobalArea } from '../api/role';
import { canSeeResource, canGlobal, firstAllowedRoute } from '../nav';

/** Requires authentication. Forces a password reset when `must_reset` is set. */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { token, user } = useAuthStore();
  const location = useLocation();

  if (!token) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (user?.must_reset && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  return <>{children}</>;
}

/**
 * Guards a resource page by the user's /me nav submenus. Admins always pass.
 * A non-permitted resource redirects to the dashboard (always visible).
 */
export function ResourceRoute({ resource, children }: { resource: string; children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const location = useLocation();

  if (canSeeResource(resource, user)) {
    return <>{children}</>;
  }
  const fallback = firstAllowedRoute(user);
  if (fallback !== location.pathname) {
    return <Navigate to={fallback} replace />;
  }
  return <>{children}</>;
}

/**
 * Guards a global (platform-level) page by the user's effective global perms.
 * Requires `view` on the area. Admins always pass.
 */
export function GlobalRoute({ area, children }: { area: GlobalArea; children: ReactNode }) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const location = useLocation();

  if (canGlobal(area, 'view', user)) {
    return <>{children}</>;
  }
  const fallback = firstAllowedRoute(user);
  if (fallback !== location.pathname) {
    return <Navigate to={fallback} replace />;
  }
  return <Result status="403" title="403" subTitle={t('error403.subtitle')} />;
}
