import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './layouts/AppShell';
import { useAuth } from './lib/auth';
import { Loading } from './components/ui';
import Login from './pages/Login';
import { ProductHome, ProductPage, RequireProduct } from './lib/products';
const PlatformOverview = lazy(() => import('./pages/platform/Overview'));
const Companies = lazy(() => import('./pages/platform/Companies'));
const CompanyNew = lazy(() => import('./pages/platform/CompanyNew'));
const CompanyDetail = lazy(() => import('./pages/platform/CompanyDetail'));
const Plans = lazy(() => import('./pages/platform/Plans'));
const PlatformUsers = lazy(() => import('./pages/platform/Users'));
const Registros = lazy(() => import('./pages/platform/Registros'));
const Citas = lazy(() => import('./pages/platform/Citas'));
const Salud = lazy(() => import('./pages/platform/Salud'));
const AiCosts = lazy(() => import('./pages/company/AiCosts'));
const MyPlan = lazy(() => import('./pages/company/MyPlan'));
const Reactivation = lazy(() => import('./pages/company/Reactivation'));
const Collections = lazy(() => import('./pages/company/Collections'));
const SalesAudit = lazy(() => import('./pages/company/SalesAudit'));
const Incidents = lazy(() => import('./pages/platform/Incidents'));
const LegalTerms = lazy(() => import('./pages/public/Legal').then((m) => ({ default: m.Terms })));
const Privacy = lazy(() => import('./pages/public/Legal').then((m) => ({ default: m.Privacy })));
const DataDeletion = lazy(() => import('./pages/public/Legal').then((m) => ({ default: m.DataDeletion })));
const Contact = lazy(() => import('./pages/public/Legal').then((m) => ({ default: m.Contact })));
const TermsAdmin = lazy(() => import('./pages/platform/TermsAdmin'));
const Ventas = lazy(() => import('./pages/platform/Ventas'));
const Subscriptions = lazy(() => import('./pages/platform/Subscriptions'));
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
const ProductionsHome = lazy(() => import('./pages/company/productions/Home'));
const ProductionsList = lazy(() => import('./pages/company/productions/List'));
const ProductionDetail = lazy(() => import('./pages/company/productions/Detail'));
const ProductionResources = lazy(() => import('./pages/company/productions/Resources'));
const ProductionSettings = lazy(() => import('./pages/company/productions/Settings'));
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
const CreativeHome = lazy(() => import('./pages/company/creative/CreativeHome'));
const AdsHome = lazy(() => import('./pages/company/ads/AdsHome'));
// Laboratorio visual: solo existe en desarrollo (no entra al build de producción)
const CreativeLab = import.meta.env.DEV ? lazy(() => import('./pages/dev/CreativeLab')) : null;
const CreativeEditor = lazy(() => import('./pages/company/creative/Editor'));
const Deliveries = lazy(() => import('./pages/company/Deliveries'));
const CourierApp = lazy(() => import('./pages/courier/CourierApp'));
const Tracking = lazy(() => import('./pages/public/Tracking'));
const Campaigns = lazy(() => import('./pages/company/Campaigns'));
const PrintOrder = lazy(() => import('./pages/print/PrintOrder'));
const PublicMenu = lazy(() => import('./pages/public/Menu'));
const Landing = lazy(() => import('./pages/public/Landing'));
const Signup = lazy(() => import('./pages/public/Signup'));
const ForgotPassword = lazy(() => import('./pages/public/Account').then((m) => ({ default: m.ForgotPassword })));
const ResetPassword = lazy(() => import('./pages/public/Account').then((m) => ({ default: m.ResetPassword })));
const AcceptInvitation = lazy(() => import('./pages/public/Account').then((m) => ({ default: m.AcceptInvitation })));
const Onboarding = lazy(() => import('./pages/company/Onboarding'));
const Library = lazy(() => import('./pages/company/Library'));
const AutomationOpportunities = lazy(() => import('./pages/company/Opportunities'));

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
      <Route path="/recuperar" element={<ForgotPassword />} />
      <Route path="/restablecer" element={<ResetPassword />} />
      <Route path="/invitacion" element={<AcceptInvitation />} />
      <Route path="/terminos" element={<LegalTerms />} />
      <Route path="/privacidad" element={<Privacy />} />
      <Route path="/eliminacion-de-datos" element={<DataDeletion />} />
      <Route path="/contacto" element={<Contact />} />
      {CreativeLab && <Route path="/lab/creative" element={<CreativeLab />} />}
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
        <Route path="/platform/suscripciones" element={<RequirePlatform><Subscriptions /></RequirePlatform>} />
        <Route path="/platform/personas" element={<RequirePlatform><Personas /></RequirePlatform>} />
        <Route path="/platform/emails" element={<RequirePlatform><Emails /></RequirePlatform>} />
        <Route path="/platform/models" element={<RequirePlatform><AiModels /></RequirePlatform>} />
        <Route path="/platform/usage" element={<RequirePlatform><PlatformUsage /></RequirePlatform>} />
        <Route path="/platform/users" element={<RequirePlatform><PlatformUsers /></RequirePlatform>} />
        <Route path="/platform/registros" element={<RequirePlatform><Registros /></RequirePlatform>} />
        <Route path="/platform/citas" element={<RequirePlatform><Citas /></RequirePlatform>} />
        <Route path="/platform/salud" element={<RequirePlatform><Salud /></RequirePlatform>} />
        <Route path="/platform/ventas" element={<RequirePlatform><Ventas /></RequirePlatform>} />
        <Route path="/platform/publicidad" element={<RequirePlatform><Publicidad /></RequirePlatform>} />
        <Route path="/platform/terminos" element={<RequirePlatform><TermsAdmin /></RequirePlatform>} />
        <Route path="/platform/incidentes" element={<RequirePlatform><Incidents /></RequirePlatform>} />
        <Route path="/platform/audit" element={<RequirePlatform><Audit /></RequirePlatform>} />
        <Route path="/platform/dev" element={<RequirePlatform><DevTools /></RequirePlatform>} />

        {/* Panel de empresa (admin/viewer; plataforma con empresa activa) */}
        <Route path="/app" element={<BlockArea><ProductHome><Dashboard /></ProductHome></BlockArea>} />
        <Route path="/app/inbox" element={<RequireProduct any={['AUTOMATION']}><BlockArea><Inbox /></BlockArea></RequireProduct>} />
        {/* Módulo de pedidos (empresas con el módulo "orders") */}
        <Route path="/app/orders" element={<RequireProduct any={['AUTOMATION']}><BlockArea><Orders /></BlockArea></RequireProduct>} />
        <Route path="/app/orders/settings" element={<RequireProduct any={['AUTOMATION']}><BlockArea><OrdersSettings /></BlockArea></RequireProduct>} />
        <Route path="/app/orders/reports" element={<RequireProduct any={['AUTOMATION']}><BlockArea><OrdersReports /></BlockArea></RequireProduct>} />
        <Route path="/app/orders/:id" element={<RequireProduct any={['AUTOMATION']}><BlockArea><OrderDetail /></BlockArea></RequireProduct>} />
        <Route path="/app/customers" element={<RequireProduct any={['AUTOMATION']}><BlockArea><Customers /></BlockArea></RequireProduct>} />
        <Route path="/app/deliveries" element={<RequireProduct any={['AUTOMATION']}><BlockArea><Deliveries /></BlockArea></RequireProduct>} />
        <Route path="/app/marketing" element={<RequireProduct any={['CREATIVE']}><BlockArea><Marketing /></BlockArea></RequireProduct>} />
        <Route path="/app/creative" element={<RequireProduct any={['CREATIVE']}><BlockArea><CreativeHome /></BlockArea></RequireProduct>} />
        <Route path="/app/producto/:key" element={<BlockArea><ProductPage /></BlockArea>} />
        <Route path="/app/biblioteca" element={<BlockArea><RequireProduct any={['CREATIVE', 'ADS']}><Library /></RequireProduct></BlockArea>} />
        <Route path="/app/ads" element={<RequireProduct any={['ADS']}><BlockArea><AdsHome /></BlockArea></RequireProduct>} />
        <Route path="/app/creative/editor/:id" element={<RequireProduct any={['CREATIVE']}><BlockArea><CreativeEditor /></BlockArea></RequireProduct>} />
        <Route path="/app/area" element={<RequireProduct any={['AUTOMATION']}><AreaView /></RequireProduct>} />
        <Route path="/app/oportunidades" element={<RequireProduct any={['AUTOMATION']}><BlockArea><AutomationOpportunities /></BlockArea></RequireProduct>} />
        <Route path="/app/contacts" element={<RequireProduct any={['AUTOMATION']}><Contacts /></RequireProduct>} />
        <Route path="/app/campaigns" element={<RequireProduct any={['AUTOMATION']}><BlockArea><Campaigns /></BlockArea></RequireProduct>} />
        <Route path="/app/bienvenida" element={<BlockArea><Onboarding /></BlockArea>} />
        <Route path="/app/bots" element={<RequireProduct any={['AUTOMATION']}><Bots /></RequireProduct>} />
        <Route path="/app/bots/:id" element={<RequireProduct any={['AUTOMATION']}><BotDetail /></RequireProduct>} />
        <Route path="/app/automations" element={<RequireProduct any={['AUTOMATION']}><Automations /></RequireProduct>} />
        <Route path="/app/integrations" element={<RequireProduct any={['AUTOMATION']}><Integrations /></RequireProduct>} />
        <Route path="/app/lines/:id" element={<RequireProduct any={['AUTOMATION']}><LineDetail /></RequireProduct>} />
        <Route path="/app/media" element={<RequireProduct any={['AUTOMATION']}><Media /></RequireProduct>} />
        <Route path="/app/usage" element={<Usage />} />
        <Route path="/app/costos-ia" element={<RequireProduct any={['AUTOMATION']}><AiCosts /></RequireProduct>} />
        <Route path="/app/mi-plan" element={<MyPlan />} />
        <Route path="/app/reactivacion" element={<RequireProduct any={['AUTOMATION']}><Reactivation /></RequireProduct>} />
        <Route path="/app/cobranza" element={<RequireProduct any={['AUTOMATION']}><Collections /></RequireProduct>} />
        <Route path="/app/auditor" element={<RequireProduct any={['AUTOMATION']}><SalesAudit /></RequireProduct>} />
        <Route path="/app/agenda" element={<RequireProduct any={['AUTOMATION']}><Agenda /></RequireProduct>} />
        <Route path="/app/productions" element={<RequireProduct any={['AUTOMATION']}><ProductionsHome /></RequireProduct>} />
        <Route path="/app/productions/list" element={<RequireProduct any={['AUTOMATION']}><ProductionsList /></RequireProduct>} />
        <Route path="/app/productions/resources" element={<RequireProduct any={['AUTOMATION']}><ProductionResources /></RequireProduct>} />
        <Route path="/app/productions/settings" element={<RequireProduct any={['AUTOMATION']}><ProductionSettings /></RequireProduct>} />
        <Route path="/app/productions/:id" element={<RequireProduct any={['AUTOMATION']}><ProductionDetail /></RequireProduct>} />
        <Route path="/app/gerencia" element={<RequireProduct any={['AUTOMATION']}><Gerencia /></RequireProduct>} />
        <Route path="/app/analytics" element={<RequireProduct any={['AUTOMATION']}><Analytics /></RequireProduct>} />
        <Route path="/app/billing" element={<Billing />} />
        <Route path="/app/team" element={<Team />} />
        <Route path="/app/settings" element={<CompanySettings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}
