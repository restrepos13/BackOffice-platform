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
apps/api   → NestJS 10 + Prisma (MongoDB Atlas) — puerto 4001, prefijo /api
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
sin que lo pida (levantar para verificar y apagar está bien; excepción actual:
la demo por túnel ngrok quedó corriendo a pedido). **No subir a ningún remoto**
sin que lo pida.

**Base de datos: MongoDB Atlas** (definitiva, desde el 21 sep 2026).
`DATABASE_URL` en `apps/api/.env` (NO commiteado) con formato
`mongodb+srv://…mongodb.net/backoffice?retryWrites=true&w=majority` — el nombre
de la base en la URL es obligatorio. Provider `mongodb` en el schema; todos los
`@id` son cuid mapeados a `_id` (`@map("_id")`). Los enums siguen siendo String
y los JSON van serializados en campos `*Json` (funciona igual en Mongo). No usar
SQL crudo: el health check usa `$runCommandRaw({ ping: 1 })`. `prisma db push`
sincroniza índices contra Atlas y el seed corre directo contra la nube.

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
- `bots` — asistentes IA por empresa: systemPrompt, personalidad JSON, modelo (id de DeepInfra), memoria, handoff, **tiempos de respuesta humanizados** (`replyDelayMinSec/MaxSec`, `typingSimulation`) y **habilidades de venta** (`salesJson`: goal/style/catalog/upsell/objections — el modo chatter)
- `integrations` — canales + **líneas WhatsApp**: una empresa puede tener N integraciones type WHATSAPP (una por modelo/área/campaña). Cada línea tiene `promptMode`: `INHERIT` (usa el bot) o `CUSTOM` (prompt/personalidad/bienvenida/handoff/modelo/temperatura propios, más `overrideReplyDelayMin/MaxSec` y `overrideSalesJson` — ventas por línea). `POST /integrations/:id/clone` clona la línea. Los `connectUrl` de Meta se generan con `buildConnectUrl()` desde `META_APP_ID` — **no se guardan credenciales de cuentas**
- `personas` — **biblioteca de personalidades**: plantillas globales (companyId null, las gestiona plataforma) + propias por empresa; se aplican a bots o líneas
- `aimodels` — **catálogo DeepInfra** (`AiModel`): costos USD/1M tokens que se DECLARAN al cliente (los ve en Facturación); solo plataforma edita; los selects de modelo de bots/líneas salen de aquí (`ModelSelect` en `components/media.tsx`)
- `aiusage` — **consumo IA BYOK**: cada empresa pone SU llave de DeepInfra (`Company.deepinfraApiKey`, se configura en Configuración del panel de empresa; enmascarada en el API, jamás viaja completa) y el costo de IA lo paga el cliente DIRECTO al proveedor (no entra en la mensualidad — billing lo marca `directBilled`). `AiUsageEvent` = un registro por respuesta (tokens, modelo, línea, costo); lo escribirá el motor, el seed genera histórico. Endpoints: `GET /ai-usage/company` (filtros days/integrationId/model, serie diaria, desgloses, proyección fin de mes) y `GET /ai-usage/platform` (global + ranking por empresa). Páginas: `/app/usage` y `/platform/usage`, auto-refresh 30s
- `media` — **galería**: la empresa sube fotos (solo jpg/png/webp/gif, 10 MB, multer en memoria, nombre aleatorio en `apps/api/uploads/<companyId>/`) con precio PPV/etiquetas/línea; se sirven SOLO vía `GET /media/:id/file` autenticado con control de tenant (el front usa `MediaImage` que baja el blob con el JWT); `POST /conversations/:id/messages` acepta `mediaAssetId` (valida tenant) — así el agente/IA envía fotos en el chat
- `contacts` — CRM con etapas CURIOSO → POTENCIAL → CALIENTE → CLIENTE / DESCARTADO
- `conversations` — bandeja: mensajes (CONTACT/BOT/AGENT), estados OPEN/PENDING/HANDOFF/RESOLVED, `needsAttention`, filtro por línea (`integrationId`), enviar mensaje como humano pasa a HANDOFF
- `automations` — flujos/reportes/contenido con runs y successRate
- `metrics` — `/metrics/platform` (MRR, series, top empresas) y `/metrics/company` (KPIs, series 30d, embudo, canales y **ranking por línea** `lines[]`)
- `billing` — `/billing/summary` = plan + consumo desglosado (IA tokens, WhatsApp API, storage) al costo; `/billing/invoices`
- `payments` — **pasarela Wompi (Colombia)**: `POST /payments/checkout` genera Web Checkout con firma de integridad SHA-256 y conversión USD→COP (`USD_COP_RATE`); webhook público `POST /payments/wompi/events` verifica firma de eventos (`WOMPI_EVENTS_SECRET`), APPROVED → factura PAID. Internacional (Stripe) pendiente, provider reservado
- `emails` — **correos a empresas** (solo SUPER_ADMIN/DEV): nodemailer con SMTP de PlatformSettings; variables `{{empresa}} {{plan}} {{contacto}}`; sin SMTP → QUEUED con `POST /emails/resend`
- `ops` — **Agenda + Seguimientos + Reporte a Gerencia**: `Appointment` (citas con estados SCHEDULED/CONFIRMED/COMPLETED/CANCELLED/NO_SHOW, source MANUAL|IA) y `FollowUp` (recordatorios con vencimiento). `GET /ops/executive` = el "bot jefe" de la landing calculado en vivo: áreas auditadas OK/atención, semana vs semana, ahorro estimado en sueldos (params `Company.savingsSalaryUsd` + `agentCapacityPerMonth`, editables en Configuración) y pendientes accionables. Páginas: `/app/agenda`, `/app/gerencia`; modales de cita/seguimiento reutilizados en la bandeja; Dashboard con saludo + checklist "Primeros pasos" + tira de agenda; Contactos con vista tablero y export CSV
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

## Seeds y cuentas

**`pnpm db:seed` = seed de PRODUCCIÓN** (desde el 21 sep 2026): limpia todo y
deja planes, catálogo IA, personalidades globales, settings, el equipo
BackOffice y UNA "Empresa de Prueba" vacía. ⚠️ Nunca correrlo sin pensar cuando
haya datos reales de clientes — borra todo.
Los datos demo (4 empresas, conversaciones, consumo) viven en
`prisma/seed-demo.ts` → `pnpm db:seed:demo`.

Cuentas reales (contraseñas en el encabezado de `prisma/seed.ts`, todas fuertes;
la vieja `backoffice2026` ya no existe):
- `santiago@backoffice.dev` / `daniel@backoffice.dev` — SUPER_ADMIN
- `restrepos591@gmail.com` / `danielloaiza609@gmail.com` — DEV (fundadores)
- `admin@empresa-prueba.com` — COMPANY_ADMIN de la Empresa de Prueba (vacía)

## Pendiente (fase 2)

1. **Base de datos definitiva** — el usuario dirá cuál; cambio en datasource.
2. Motor de respuesta IA real + webhooks entrantes de WhatsApp/Meta
   (los webhookUrl ya existen por línea: `/api/webhooks/<slug>/<canal>`).
3. Callback OAuth de Meta (`/integrations/meta/callback`) para conectar cuentas.
4. Llaves reales de Wompi + cuenta SMTP → se cargan en Dev Tools, sin código.
5. Pasarela internacional (Stripe).

## Seguridad (ya endurecida — no aflojar)

- Rate limiting: global 200 req/min/IP (`ThrottlerModule`), login 10/min (`@Throttle`).
  OJO: correr muchos logins seguidos en pruebas dispara el 429 (es esperado).
- Helmet + payload máx. 1 MB en `main.ts`; JWT_SECRET fuerte en `.env` (NO
  commiteado, hay `.env.example`); si falta, se genera uno efímero al arrancar.
- Webhook Wompi exige firma salvo `WOMPI_ENV=test`. Uploads: solo imágenes
  (SVG rechazado), nunca servidos como estáticos.
- Suite E2E+seguridad de 42 checks: `test_full.py` (en el scratchpad de la
  sesión que la creó; recrear si hace falta — cubre auth, headers, tenancy,
  roles, galería, fotos en chat, modelos, Wompi, aprovisionamiento y rate limit).
- El frontend es **responsive**: sidebar se vuelve drawer con hamburguesa en
  `<lg` (AppShell), la bandeja alterna lista/detalle en móvil.

## Convenciones al trabajar aquí

- Todo el texto de UI y los mensajes de API en **español**.
- Nuevo dominio de API = un solo archivo en `modules/` siguiendo el patrón existente; registrar en `app.module.ts`; loguear mutaciones con `AuditService`; scoping con `scopeCompanyId`.
- Nueva página = usar el kit de `components/ui.tsx` y los tokens (no inventar estilos); en panel de empresa usar `useCompanyScope()` y respetar `canWrite`.
- Campos JSON en Prisma: guardar con `JSON.stringify` en `*Json` y exponer parseado en el serializer del service (`parseJson`).
- Tras cambiar `schema.prisma`: `npx prisma db push` + actualizar `seed.ts` + reseed.
- El repo git es **local del proyecto** (ojo: la carpeta HOME del usuario también es un repo git accidental — jamás `git add` fuera del proyecto).
