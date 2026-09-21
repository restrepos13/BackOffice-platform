# BackOffice Platform — contexto del proyecto

Lee esto primero. Es el mapa completo del proyecto para cualquier IA o sesión nueva.

## Qué es

CRM/plataforma **multi-tenant** de BackOffice (estudio de automatización con IA de
Santiago y Daniel). Las empresas clientes (estudios webcam, clínicas,
concesionarios, inmobiliarias…) consumen desde aquí los servicios del estudio:
chatbots IA por WhatsApp, automatizaciones y analytics. Un solo panel sirve a
todas las empresas, con roles distintos por tipo de usuario.

- Landing pública de referencia (el diseño sale de ahí): https://backoffice-alpha-jade.vercel.app/
- Fase actual: **fase 1 completa** — todo el panel montado y funcional con datos
  demo. Sin motor de IA real ni webhooks de Meta todavía (fase 2).

## Stack y arranque

Monorepo **pnpm** (sin Docker — el usuario no lo usa; servicios locales).

```
apps/api   → NestJS 10 + Prisma (SQLite provisional) — puerto 4001, prefijo /api
apps/web   → React 18 + Vite + Tailwind 4 + TanStack Query + Recharts + sonner — puerto 5173 (proxy /api → 4001)
```

```bash
pnpm install
pnpm db:push      # crea/actualiza la base (SQLite: apps/api/prisma/dev.db)
pnpm db:seed      # datos demo (borra y recrea todo)
pnpm dev          # api + web en paralelo
```

Verificación: `npx tsc --noEmit` en cada app; build con `npx nest build` /
`npx vite build`.

⚠️ Reglas del usuario: **no dejar servidores corriendo ni puertos ocupados**
sin que lo pida (levantar para verificar y apagar está bien). **No subir a
ningún remoto** sin que lo pida. La **base de datos definitiva está pendiente**:
cuando la diga, se cambia `provider` en `apps/api/prisma/schema.prisma` y
`DATABASE_URL` en `apps/api/.env` (por eso los enums son String y los JSON van
serializados en campos `*Json` — compatibilidad SQLite).

## Roles (RBAC)

| Rol | Quién | Acceso |
|---|---|---|
| `SUPER_ADMIN` | Santiago y Daniel | Panel de plataforma completo + puede entrar al panel de cualquier empresa (selector en sidebar) |
| `DEV` | Desarrollador del equipo | Igual que super admin (pensado para Dev Tools) |
| `COMPANY_ADMIN` | Dueño de la empresa cliente | Panel de su empresa: todo editable |
| `COMPANY_VIEWER` | Empleado del cliente | Panel de su empresa: solo lectura (la UI oculta acciones vía `canWrite`) |

Aislamiento por tenant: `scopeCompanyId()` en
`apps/api/src/common/constants.ts` — roles de empresa quedan clavados a su
`companyId`; roles de plataforma pasan `?companyId=` en las peticiones.
Guards globales: `JwtAuthGuard` + `RolesGuard` (`apps/api/src/auth/`).

## Mapa del backend (`apps/api/src`)

Cada dominio es un archivo `modules/<x>.module.ts` con service + controller + module juntos:

- `auth/` — login JWT (12h), `/auth/me`, decoradores `@Public`, `@Roles`, `@CurrentUser`
- `companies` — CRUD + **aprovisionamiento**: `POST /companies` recibe el wizard completo (datos, plan, límites con overrides, módulos, admin inicial, bot inicial, canales) y crea todo el tenant
- `plans` — Starter $299 / Growth $599 / Scale $999 / Enterprise (de la landing)
- `bots` — asistentes IA por empresa: systemPrompt, personalidad JSON, modelo, memoria, handoff
- `integrations` — canales + **líneas WhatsApp**: una empresa puede tener N integraciones type WHATSAPP (una por modelo/área/campaña). Cada línea tiene `promptMode`: `INHERIT` (usa el bot) o `CUSTOM` (prompt/personalidad/bienvenida/handoff/modelo/temperatura propios). `POST /integrations/:id/clone` clona la línea. Los `connectUrl` de Meta se generan con `buildConnectUrl()` desde `META_APP_ID` — **no se guardan credenciales de cuentas**
- `personas` — **biblioteca de personalidades**: plantillas globales (companyId null, las gestiona plataforma) + propias por empresa; se aplican a bots o líneas
- `contacts` — CRM con etapas CURIOSO → POTENCIAL → CALIENTE → CLIENTE / DESCARTADO
- `conversations` — bandeja: mensajes (CONTACT/BOT/AGENT), estados OPEN/PENDING/HANDOFF/RESOLVED, `needsAttention`, filtro por línea (`integrationId`), enviar mensaje como humano pasa a HANDOFF
- `automations` — flujos/reportes/contenido con runs y successRate
- `metrics` — `/metrics/platform` (MRR, series, top empresas) y `/metrics/company` (KPIs, series 30d, embudo, canales y **ranking por línea** `lines[]`)
- `billing` — `/billing/summary` = plan + consumo desglosado (IA tokens, WhatsApp API, storage) al costo; `/billing/invoices`
- `payments` — **pasarela Wompi (Colombia)**: `POST /payments/checkout` genera Web Checkout con firma de integridad SHA-256 y conversión USD→COP (`USD_COP_RATE`); webhook público `POST /payments/wompi/events` verifica firma de eventos (`WOMPI_EVENTS_SECRET`), APPROVED → factura PAID. Internacional (Stripe) pendiente, provider reservado
- `emails` — **correos a empresas** (solo SUPER_ADMIN/DEV): nodemailer con SMTP de PlatformSettings; variables `{{empresa}} {{plan}} {{contacto}}`; sin SMTP → QUEUED con `POST /emails/resend`
- `audit` — AuditService global; todas las mutaciones importantes loguean
- `devtools` — `/dev/health`, API keys (secreto mostrado una sola vez), `/dev/settings` (PlatformSetting key-value: META_*, WOMPI_*, SMTP_*, USD_COP_RATE)

Esquema completo: `apps/api/prisma/schema.prisma`. Seed: `apps/api/prisma/seed.ts`.

## Mapa del frontend (`apps/web/src`)

- `styles.css` — **design system** (tokens Tailwind 4 en `@theme`): editorial
  brutalista de la landing. Hueso `#E6E1DD`, tinta `#1A1A1A`, Anton (títulos
  uppercase, clase `display`), Playfair Display itálica (acentos, `serif-accent`),
  Geist (cuerpo), etiquetas `kicker`, esquinas rectas, bordes `border-2 border-ink`,
  sombras duras. **Nada de emojis como íconos** (lucide-react), nada de dark genérico.
- `components/ui.tsx` — kit: Button, Card, Stat, Badge (+`statusTone()`), Field,
  Input/Select/Textarea/Switch, Table, Tabs, Modal, EmptyState, Loading, PageHeader
- `components/charts.tsx` — Recharts estilizados (step areas tinta/verde)
- `components/PersonaPicker.tsx` — modal biblioteca de personalidades
- `lib/` — `api.ts` (fetch + token localStorage), `auth.tsx` (AuthProvider,
  `useAuth`, `useActiveCompanyId` = empresa activa para roles de plataforma),
  `types.ts`, `format.ts` (labels ES + formateadores)
- `layouts/AppShell.tsx` — sidebar por rol + selector "Panel de empresa" + banners viewer/dev
- `pages/platform/` — Overview, Companies, **CompanyNew (wizard 6 pasos)**,
  CompanyDetail (tabs + zona de riesgo), Plans, Personas, Users, Emails, Audit, DevTools
- `pages/company/` — Dashboard, Inbox (chat + intervención humana), Contacts,
  Bots + BotDetail, **LineDetail (editor de línea: modo heredar/propio +
  instrucciones efectivas)**, Automations, Integrations (líneas WA + otros canales),
  Analytics (ranking de líneas), Billing (plan + consumo = mensualidad, botón
  Pagar con Wompi), Team, Settings. `shared.tsx` = `useCompanyScope()`/`withScope()`

## Datos demo (seed) — contraseña de todos: `backoffice2026`

- Plataforma: `santiago@backoffice.dev`, `daniel@backoffice.dev` (SUPER_ADMIN), `dev@backoffice.dev` (DEV)
- **Mas Salud Latam** (clínica CR, Growth): `admin@` / `vista@massaludlatam.com` — 2 líneas WA (Citas hereda, Ventas custom), bot auditor
- **HM Motors** (concesionario CR, Starter): `admin@` / `vista@hmmotors.net` — factura OVERDUE para probar Wompi
- **Lotes Ancestral** (inmobiliaria CO, TRIAL): `admin@lotesancestral.com` — canales sin conectar
- **Nova Studio** (agencia webcam CO, Growth): `admin@` / `monitor@novastudio.co` — 4 líneas-perfil (Valentina, Sofía, Isabella, Luna) todas con personalidad CUSTOM
- 5 plantillas globales de personalidad, 45 días de consumo por empresa, facturas, pago Wompi demo, correo en cola

## Pendiente (fase 2)

1. **Base de datos definitiva** — el usuario dirá cuál; cambio en datasource.
2. Motor de respuesta IA real + webhooks entrantes de WhatsApp/Meta
   (los webhookUrl ya existen por línea: `/api/webhooks/<slug>/<canal>`).
3. Callback OAuth de Meta (`/integrations/meta/callback`) para conectar cuentas.
4. Llaves reales de Wompi + cuenta SMTP → se cargan en Dev Tools, sin código.
5. Pasarela internacional (Stripe).

## Convenciones al trabajar aquí

- Todo el texto de UI y los mensajes de API en **español**.
- Nuevo dominio de API = un solo archivo en `modules/` siguiendo el patrón existente; registrar en `app.module.ts`; loguear mutaciones con `AuditService`; scoping con `scopeCompanyId`.
- Nueva página = usar el kit de `components/ui.tsx` y los tokens (no inventar estilos); en panel de empresa usar `useCompanyScope()` y respetar `canWrite`.
- Campos JSON en Prisma: guardar con `JSON.stringify` en `*Json` y exponer parseado en el serializer del service (`parseJson`).
- Tras cambiar `schema.prisma`: `npx prisma db push` + actualizar `seed.ts` + reseed.
- El repo git es **local del proyecto** (ojo: la carpeta HOME del usuario también es un repo git accidental — jamás `git add` fuera del proyecto).
