import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { App as AntApp, ConfigProvider, Spin } from 'antd';
import type { Locale } from 'antd/es/locale';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import jaJP from 'antd/locale/ja_JP';
import { useTranslation } from 'react-i18next';
import { getTheme } from './theme';
import { useUiStore } from './store/ui';
import { useAuthStore } from './store/auth';
import { authApi } from './api/auth';
import { ProtectedRoute, ResourceRoute, GlobalRoute } from './components/ProtectedRoute';
import AppLayout from './components/AppLayout';
import Login from './pages/Login';
import ChangePassword from './pages/ChangePassword';
import Dashboard from './pages/dashboard/Dashboard';
import Clusters from './pages/clusters/Clusters';
import Users from './pages/users/Users';
import Roles from './pages/roles/Roles';
import Deployments from './pages/workloads/Deployments';
import DeploymentDetail from './pages/workloads/DeploymentDetail';
import StatefulSets from './pages/workloads/StatefulSets';
import StatefulSetDetail from './pages/workloads/StatefulSetDetail';
import DaemonSets from './pages/workloads/DaemonSets';
import DaemonSetDetail from './pages/workloads/DaemonSetDetail';
import Pods from './pages/workloads/Pods';
import Jobs from './pages/workloads/Jobs';
import CronJobs from './pages/workloads/CronJobs';
import CronJobDetail from './pages/workloads/CronJobDetail';
import Services from './pages/networking/Services';
import Ingresses from './pages/networking/Ingresses';
import ConfigMaps from './pages/storage/ConfigMaps';
import Secrets from './pages/storage/Secrets';
import PVCs from './pages/storage/PVCs';
import Nodes from './pages/cluster/Nodes';
import PersistentVolumes from './pages/cluster/PersistentVolumes';
import Releases from './pages/releases/Releases';
import IntegratedDeploy from './pages/integratedDeploy/IntegratedDeploy';
import DeployOrderEditor from './pages/integratedDeploy/DeployOrderEditor';
import ApiResources from './pages/apiResources/ApiResources';
import AuditLogs from './pages/audit/AuditLogs';
import AiConfig from './pages/ai/AiConfig';
import AiAssistant from './components/AiAssistant';

const ANTD_LOCALES: Record<string, Locale> = {
  zh: zhCN,
  en: enUS,
  ja: jaJP,
};

export default function App() {
  const mode = useUiStore((s) => s.mode);
  const { token, user, setUser } = useAuthStore();
  const { i18n } = useTranslation();
  const antdLocale = ANTD_LOCALES[i18n.language] ?? zhCN;

  // Expose the active theme on <body> so theme-scoped CSS (e.g. opaque fixed
  // table columns) can pick the right colors.
  useEffect(() => {
    document.body.dataset.theme = mode;
  }, [mode]);

  // Hydrate the current user when a token exists but the user isn't loaded yet.
  // If hydration fails (stale/invalid token, server error), drop the token so
  // the app falls back to the login screen instead of hanging on the loader.
  useEffect(() => {
    if (token && !user) {
      authApi.me().then(setUser).catch(() => useAuthStore.getState().logout());
    }
  }, [token, user, setUser]);

  return (
    <ConfigProvider theme={getTheme(mode)} locale={antdLocale}>
      <AntApp>
        <AppRoutes />
      </AntApp>
    </ConfigProvider>
  );
}

function AppRoutes() {
  const { token, user } = useAuthStore();

  // Token present but user not hydrated yet → show a graceful loader.
  if (token && !user) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/change-password" element={<ChangePassword />} />

      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
            <AiAssistant />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/workloads/deployments" element={<ResourceRoute resource="deployments"><Deployments /></ResourceRoute>} />
        <Route path="/workloads/deployments/:namespace/:name" element={<ResourceRoute resource="deployments"><DeploymentDetail /></ResourceRoute>} />
        <Route path="/workloads/statefulsets" element={<ResourceRoute resource="statefulsets"><StatefulSets /></ResourceRoute>} />
        <Route path="/workloads/statefulsets/:namespace/:name" element={<ResourceRoute resource="statefulsets"><StatefulSetDetail /></ResourceRoute>} />
        <Route path="/workloads/daemonsets" element={<ResourceRoute resource="daemonsets"><DaemonSets /></ResourceRoute>} />
        <Route path="/workloads/daemonsets/:namespace/:name" element={<ResourceRoute resource="daemonsets"><DaemonSetDetail /></ResourceRoute>} />
        <Route path="/workloads/pods" element={<ResourceRoute resource="pods"><Pods /></ResourceRoute>} />
        <Route path="/workloads/jobs" element={<ResourceRoute resource="jobs"><Jobs /></ResourceRoute>} />
        <Route path="/workloads/cronjobs" element={<ResourceRoute resource="cronjobs"><CronJobs /></ResourceRoute>} />
        <Route path="/workloads/cronjobs/:namespace/:name" element={<ResourceRoute resource="cronjobs"><CronJobDetail /></ResourceRoute>} />
        <Route path="/networking/services" element={<ResourceRoute resource="services"><Services /></ResourceRoute>} />
        <Route path="/networking/ingresses" element={<ResourceRoute resource="ingresses"><Ingresses /></ResourceRoute>} />
        <Route path="/storage/configmaps" element={<ResourceRoute resource="configmaps"><ConfigMaps /></ResourceRoute>} />
        <Route path="/storage/secrets" element={<ResourceRoute resource="secrets"><Secrets /></ResourceRoute>} />
        <Route path="/storage/pvcs" element={<ResourceRoute resource="persistentvolumeclaims"><PVCs /></ResourceRoute>} />
        <Route path="/storage/persistentvolumes" element={<ResourceRoute resource="persistentvolumes"><PersistentVolumes /></ResourceRoute>} />
        <Route path="/cluster/nodes" element={<ResourceRoute resource="nodes"><Nodes /></ResourceRoute>} />
        <Route path="/api-resources" element={<ApiResources />} />
        <Route path="/releases" element={<GlobalRoute area="releases"><Releases /></GlobalRoute>} />
        <Route path="/integrated-deploy" element={<GlobalRoute area="integrated_deploy"><IntegratedDeploy /></GlobalRoute>} />
        <Route path="/integrated-deploy/orders/:id" element={<GlobalRoute area="integrated_deploy"><DeployOrderEditor /></GlobalRoute>} />
        <Route path="/integrated-deploy/new" element={<GlobalRoute area="integrated_deploy"><DeployOrderEditor /></GlobalRoute>} />

        <Route
          path="/clusters"
          element={
            <GlobalRoute area="clusters">
              <Clusters />
            </GlobalRoute>
          }
        />
        <Route
          path="/users"
          element={
            <GlobalRoute area="users">
              <Users />
            </GlobalRoute>
          }
        />
        <Route
          path="/roles"
          element={
            <GlobalRoute area="roles">
              <Roles />
            </GlobalRoute>
          }
        />
        <Route
          path="/audit"
          element={
            <GlobalRoute area="audit">
              <AuditLogs />
            </GlobalRoute>
          }
        />
        <Route
          path="/ai/config"
          element={
            <GlobalRoute area="ai">
              <AiConfig />
            </GlobalRoute>
          }
        />
      </Route>

      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
