import { type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './layouts/AppShell';
import { useAuth } from './lib/auth';
import { Loading } from './components/ui';
import Login from './pages/Login';
import PlatformOverview from './pages/platform/Overview';
import Companies from './pages/platform/Companies';
import CompanyNew from './pages/platform/CompanyNew';
import CompanyDetail from './pages/platform/CompanyDetail';
import Plans from './pages/platform/Plans';
import PlatformUsers from './pages/platform/Users';
import Audit from './pages/platform/Audit';
import DevTools from './pages/platform/DevTools';
import Personas from './pages/platform/Personas';
import Emails from './pages/platform/Emails';
import AiModels from './pages/platform/AiModels';
import Media from './pages/company/Media';
import LineDetail from './pages/company/LineDetail';
import Dashboard from './pages/company/Dashboard';
import Inbox from './pages/company/Inbox';
import Contacts from './pages/company/Contacts';
import Bots from './pages/company/Bots';
import BotDetail from './pages/company/BotDetail';
import Automations from './pages/company/Automations';
import Integrations from './pages/company/Integrations';
import Analytics from './pages/company/Analytics';
import Billing from './pages/company/Billing';
import Team from './pages/company/Team';
import CompanySettings from './pages/company/Settings';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading label="Verificando sesión…" />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RequirePlatform({ children }: { children: ReactNode }) {
  const { isPlatform } = useAuth();
  if (!isPlatform) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

function HomeRedirect() {
  const { user, loading, isPlatform } = useAuth();
  if (loading) return <Loading label="Verificando sesión…" />;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={isPlatform ? '/platform' : '/app'} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<HomeRedirect />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        {/* Panel de plataforma (SUPER_ADMIN / DEV) */}
        <Route path="/platform" element={<RequirePlatform><PlatformOverview /></RequirePlatform>} />
        <Route path="/platform/companies" element={<RequirePlatform><Companies /></RequirePlatform>} />
        <Route path="/platform/companies/new" element={<RequirePlatform><CompanyNew /></RequirePlatform>} />
        <Route path="/platform/companies/:id" element={<RequirePlatform><CompanyDetail /></RequirePlatform>} />
        <Route path="/platform/plans" element={<RequirePlatform><Plans /></RequirePlatform>} />
        <Route path="/platform/personas" element={<RequirePlatform><Personas /></RequirePlatform>} />
        <Route path="/platform/emails" element={<RequirePlatform><Emails /></RequirePlatform>} />
        <Route path="/platform/models" element={<RequirePlatform><AiModels /></RequirePlatform>} />
        <Route path="/platform/users" element={<RequirePlatform><PlatformUsers /></RequirePlatform>} />
        <Route path="/platform/audit" element={<RequirePlatform><Audit /></RequirePlatform>} />
        <Route path="/platform/dev" element={<RequirePlatform><DevTools /></RequirePlatform>} />

        {/* Panel de empresa (admin/viewer; plataforma con empresa activa) */}
        <Route path="/app" element={<Dashboard />} />
        <Route path="/app/inbox" element={<Inbox />} />
        <Route path="/app/contacts" element={<Contacts />} />
        <Route path="/app/bots" element={<Bots />} />
        <Route path="/app/bots/:id" element={<BotDetail />} />
        <Route path="/app/automations" element={<Automations />} />
        <Route path="/app/integrations" element={<Integrations />} />
        <Route path="/app/lines/:id" element={<LineDetail />} />
        <Route path="/app/media" element={<Media />} />
        <Route path="/app/analytics" element={<Analytics />} />
        <Route path="/app/billing" element={<Billing />} />
        <Route path="/app/team" element={<Team />} />
        <Route path="/app/settings" element={<CompanySettings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
