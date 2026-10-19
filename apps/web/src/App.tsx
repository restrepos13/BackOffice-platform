import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './layouts/AppShell';
import { useAuth } from './lib/auth';
import { Loading } from './components/ui';
import Login from './pages/Login';
const PlatformOverview = lazy(() => import('./pages/platform/Overview'));
const Companies = lazy(() => import('./pages/platform/Companies'));
const CompanyNew = lazy(() => import('./pages/platform/CompanyNew'));
const CompanyDetail = lazy(() => import('./pages/platform/CompanyDetail'));
const Plans = lazy(() => import('./pages/platform/Plans'));
const PlatformUsers = lazy(() => import('./pages/platform/Users'));
const Registros = lazy(() => import('./pages/platform/Registros'));
const AiCosts = lazy(() => import('./pages/company/AiCosts'));
const PublicTerms = lazy(() => import('./components/Terms').then((m) => ({ default: m.PublicTerms })));
const TermsAdmin = lazy(() => import('./pages/platform/TermsAdmin'));
const Ventas = lazy(() => import('./pages/platform/Ventas'));
const Publicidad = lazy(() => import('./pages/platform/Publicidad'));
const Audit = lazy(() => import('./pages/platform/Audit'));
const DevTools = lazy(() => import('./pages/platform/DevTools'));
const Personas = lazy(() => import('./pages/platform/Personas'));
const Emails = lazy(() => import('./pages/platform/Emails'));
const AiModels = lazy(() => import('./pages/platform/AiModels'));
const PlatformUsage = lazy(() => import('./pages/platform/Usage'));
const Media = lazy(() => import('./pages/company/Media'));
const Usage = lazy(() => import('./pages/company/Usage'));
const Agenda = lazy(() => import('./pages/company/Agenda'));
const Gerencia = lazy(() => import('./pages/company/Gerencia'));
const LineDetail = lazy(() => import('./pages/company/LineDetail'));
const Dashboard = lazy(() => import('./pages/company/Dashboard'));
const Inbox = lazy(() => import('./pages/company/Inbox'));
const Contacts = lazy(() => import('./pages/company/Contacts'));
const Bots = lazy(() => import('./pages/company/Bots'));
const BotDetail = lazy(() => import('./pages/company/BotDetail'));
const Automations = lazy(() => import('./pages/company/Automations'));
const Integrations = lazy(() => import('./pages/company/Integrations'));
const Analytics = lazy(() => import('./pages/company/Analytics'));
const Billing = lazy(() => import('./pages/company/Billing'));
const Team = lazy(() => import('./pages/company/Team'));
const CompanySettings = lazy(() => import('./pages/company/Settings'));
const Orders = lazy(() => import('./pages/company/Orders'));
const OrderDetail = lazy(() => import('./pages/company/OrderDetail'));
const OrdersSettings = lazy(() => import('./pages/company/OrdersSettings'));
const OrdersReports = lazy(() => import('./pages/company/OrdersReports'));
const Customers = lazy(() => import('./pages/company/Customers'));
const AreaView = lazy(() => import('./pages/company/AreaView'));
const Marketing = lazy(() => import('./pages/company/Marketing'));
const Deliveries = lazy(() => import('./pages/company/Deliveries'));
const CourierApp = lazy(() => import('./pages/courier/CourierApp'));
const Tracking = lazy(() => import('./pages/public/Tracking'));
const Campaigns = lazy(() => import('./pages/company/Campaigns'));
const PrintOrder = lazy(() => import('./pages/print/PrintOrder'));
const PublicMenu = lazy(() => import('./pages/public/Menu'));
const Landing = lazy(() => import('./pages/public/Landing'));
const Signup = lazy(() => import('./pages/public/Signup'));
const Onboarding = lazy(() => import('./pages/company/Onboarding'));

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
  // Visitante: portada pública con "Crea tu cuenta" e "Iniciar sesión"
  if (!user) return <Landing />;
  if (user.role === 'COMPANY_AREA') return <Navigate to="/app/area" replace />;
  // Empresa registrada por la web, aún en configuración → primeros pasos
  if (user.company?.status === 'ONBOARDING') return <Navigate to="/app/bienvenida" replace />;
  if (user.role === 'COMPANY_COURIER') return <Navigate to="/courier" replace />;
  return <Navigate to={isPlatform ? '/platform' : '/app'} replace />;
}

/** La app del domiciliario es solo para su rol. */
function RequireCourier({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== 'COMPANY_COURIER') return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Un usuario de área de producción SOLO entra a su vista de área. */
function BlockArea({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user?.role === 'COMPANY_AREA') return <Navigate to="/app/area" replace />;
  return <>{children}</>;
}

export default function App() {
  // Cada pantalla se carga al visitarla: el link público de seguimiento no
  // baja el panel completo (mapas, gráficas) en el celular del cliente.
  return (
    <Suspense fallback={<Loading />}>
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Público: seguimiento del pedido para el cliente final (sin login) */}
      <Route path="/t/:token" element={<Tracking />} />
      <Route path="/m/:slug" element={<PublicMenu />} />
      <Route path="/registro" element={<Signup />} />
      <Route path="/terminos" element={<PublicTerms />} />
      <Route path="/print/order/:id" element={<RequireAuth><PrintOrder /></RequireAuth>} />
      {/* App móvil del domiciliario (fuera del panel) */}
      <Route path="/courier" element={<RequireAuth><RequireCourier><CourierApp /></RequireCourier></RequireAuth>} />
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
        <Route path="/platform/usage" element={<RequirePlatform><PlatformUsage /></RequirePlatform>} />
        <Route path="/platform/users" element={<RequirePlatform><PlatformUsers /></RequirePlatform>} />
        <Route path="/platform/registros" element={<RequirePlatform><Registros /></RequirePlatform>} />
        <Route path="/platform/ventas" element={<RequirePlatform><Ventas /></RequirePlatform>} />
        <Route path="/platform/publicidad" element={<RequirePlatform><Publicidad /></RequirePlatform>} />
        <Route path="/platform/terminos" element={<RequirePlatform><TermsAdmin /></RequirePlatform>} />
        <Route path="/platform/audit" element={<RequirePlatform><Audit /></RequirePlatform>} />
        <Route path="/platform/dev" element={<RequirePlatform><DevTools /></RequirePlatform>} />

        {/* Panel de empresa (admin/viewer; plataforma con empresa activa) */}
        <Route path="/app" element={<BlockArea><Dashboard /></BlockArea>} />
        <Route path="/app/inbox" element={<BlockArea><Inbox /></BlockArea>} />
        {/* Módulo de pedidos (empresas con el módulo "orders") */}
        <Route path="/app/orders" element={<BlockArea><Orders /></BlockArea>} />
        <Route path="/app/orders/settings" element={<BlockArea><OrdersSettings /></BlockArea>} />
        <Route path="/app/orders/reports" element={<BlockArea><OrdersReports /></BlockArea>} />
        <Route path="/app/orders/:id" element={<BlockArea><OrderDetail /></BlockArea>} />
        <Route path="/app/customers" element={<BlockArea><Customers /></BlockArea>} />
        <Route path="/app/deliveries" element={<BlockArea><Deliveries /></BlockArea>} />
        <Route path="/app/marketing" element={<BlockArea><Marketing /></BlockArea>} />
        <Route path="/app/area" element={<AreaView />} />
        <Route path="/app/contacts" element={<Contacts />} />
        <Route path="/app/campaigns" element={<BlockArea><Campaigns /></BlockArea>} />
        <Route path="/app/bienvenida" element={<BlockArea><Onboarding /></BlockArea>} />
        <Route path="/app/bots" element={<Bots />} />
        <Route path="/app/bots/:id" element={<BotDetail />} />
        <Route path="/app/automations" element={<Automations />} />
        <Route path="/app/integrations" element={<Integrations />} />
        <Route path="/app/lines/:id" element={<LineDetail />} />
        <Route path="/app/media" element={<Media />} />
        <Route path="/app/usage" element={<Usage />} />
        <Route path="/app/costos-ia" element={<AiCosts />} />
        <Route path="/app/agenda" element={<Agenda />} />
        <Route path="/app/gerencia" element={<Gerencia />} />
        <Route path="/app/analytics" element={<Analytics />} />
        <Route path="/app/billing" element={<Billing />} />
        <Route path="/app/team" element={<Team />} />
        <Route path="/app/settings" element={<CompanySettings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}
