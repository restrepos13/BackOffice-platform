# BackOffice Platform — contexto del proyecto

Lee esto primero. Es el mapa completo del proyecto para cualquier IA o sesión nueva.

## Qué es

CRM/plataforma **multi-tenant** de BackOffice (estudio de automatización con IA de
Santiago y Daniel). Las empresas clientes (estudios webcam, clínicas,
concesionarios, inmobiliarias…) consumen desde aquí los servicios del estudio:
chatbots IA por WhatsApp, automatizaciones y analytics. Un solo panel sirve a
todas las empresas, con roles distintos por tipo de usuario.

- Landing pública de referencia (el diseño sale de ahí): https://backoffice-alpha-jade.vercel.app/
- Estado (oct 2026): plataforma completa con motor IA (pedidos estructurados +
  **agente con herramientas**), WhatsApp vía Twilio (sandbox por línea), módulo de
  pedidos, **domicilios en vivo con GPS** y **IA revendida** con topes. Corre local
  (no hay hosting todavía); repo en github.com/restrepos13/BackOffice-platform.

## Stack y arranque

Monorepo **pnpm** (sin Docker — el usuario no lo usa; servicios locales).

```
apps/api   → NestJS 10 + Prisma (MongoDB Atlas) — puerto 4001, prefijo /api
apps/web   → React 18 + Vite + Tailwind 4 + TanStack Query + Recharts + sonner — puerto 5173 (proxy /api → 4001)
```

```bash
pnpm install
pnpm db:push      # sincroniza índices contra MongoDB Atlas
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
| `COMPANY_AREA` | Área de producción | Solo su vista de área (`/app/area`) |
| `COMPANY_COURIER` | Domiciliario | Solo su app móvil `/courier`: turno, ruta, GPS, recoger/entregar. Mínimo privilegio igual que área (`RESTRICTED_ROLES` en constants + RolesGuard; sin SSE) |

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
- `aiusage` — **consumo IA BYOK**: cada empresa pone SU llave de DeepInfra (`Company.deepinfraApiKey`, se configura en Configuración del panel de empresa; enmascarada en el API, jamás viaja completa) y el costo de IA lo paga el cliente DIRECTO al proveedor (no entra en la mensualidad — billing lo marca `directBilled`). `AiUsageEvent` = un registro por respuesta (tokens, modelo, línea, costo); lo escribirá el motor, el seed genera histórico. Endpoints: `GET /ai-usage/company` (filtros days/integrationId/model, serie diaria, desgloses, proyección fin de mes), `GET /ai-usage/platform` (global + ranking por empresa) y `GET /ai-usage/consumption?month=YYYY-MM` (**Fase 5**: mes calendario en la moneda de la empresa — mensajes Meta por categoría + IA, conversión con `USD_COP_RATE`, comparativo vs mes anterior con `deltaPct`). Páginas: `/app/usage` (incluye sección "Consumo del mes" en COP) y `/platform/usage`, auto-refresh 30s
- `media` — **galería**: la empresa sube fotos (solo jpg/png/webp/gif, 10 MB, multer en memoria, nombre aleatorio en `apps/api/uploads/<companyId>/`) con precio PPV/etiquetas/línea; se sirven SOLO vía `GET /media/:id/file` autenticado con control de tenant (el front usa `MediaImage` que baja el blob con el JWT); `POST /conversations/:id/messages` acepta `mediaAssetId` (valida tenant) — así el agente/IA envía fotos en el chat
- `contacts` — CRM con etapas CURIOSO → POTENCIAL → CALIENTE → CLIENTE / DESCARTADO
- `conversations` — bandeja: mensajes (CONTACT/BOT/AGENT con `authorName`), estados OPEN/PENDING/HANDOFF/RESOLVED, `needsAttention`, filtro por línea (`integrationId`). **Fase 5**: búsqueda `?q=` (nombre/teléfono del contacto o contenido de mensajes) + rango `from/to`; **modo humano explícito** `PATCH /:id/mode {mode: HUMAN|BOT}` (botPaused + attendedByName + audit; BOT limpia la alerta); escribir a mano = tomar la conversación (pausa la IA) y si el canal es WHATSAPP el mensaje **sale por la línea** vía wa-outbound (sandbox aware); archivos de mensajes servidos autenticados en `GET /conversations/messages/:id/file` (tenant-scoped, sin traversal); rol COMPANY_AREA bloqueado (403)
- `events` — **tiempo real por SSE** (Fase 5, @Global): `GET /events/stream?token=<jwt>` (EventSource no manda headers → JWT por query verificado a mano; roles de plataforma pasan `&companyId=`; heartbeat 25 s) y `POST /events/typing` (presencia "está escribiendo…" entre usuarios). EventEmitter en memoria por `co:<companyId>` (si algún día hay multi-instancia → pub/sub Redis). Emiten: twilio (message.new IN, message.status, conversation.updated en fallos), engine (message.new OUT, conversation.updated al escalar) y conversations (envíos, modo, estado). Front: hook `useLiveEvents` en `lib/events.ts` (la bandeja invalida queries al recibir eventos)
- `automations` — flujos/reportes/contenido con runs y successRate
- `metrics` — `/metrics/platform` (MRR, series, top empresas) y `/metrics/company` (KPIs, series 30d, embudo, canales y **ranking por línea** `lines[]`)
- `billing` — `/billing/summary` = plan + consumo desglosado (IA tokens, WhatsApp API, storage) al costo; `/billing/invoices`
- `payments` — **pasarela Wompi (Colombia)**: `POST /payments/checkout` genera Web Checkout con firma de integridad SHA-256 y conversión USD→COP (`USD_COP_RATE`); webhook público `POST /payments/wompi/events` verifica firma de eventos (`WOMPI_EVENTS_SECRET`), APPROVED → factura PAID. Internacional (Stripe) pendiente, provider reservado
- `emails` — **correos a empresas** (solo SUPER_ADMIN/DEV): nodemailer con SMTP de PlatformSettings; variables `{{empresa}} {{plan}} {{contacto}}`; sin SMTP → QUEUED con `POST /emails/resend`
- `ops` — **Agenda + Seguimientos + Reporte a Gerencia**: `Appointment` (citas con estados SCHEDULED/CONFIRMED/COMPLETED/CANCELLED/NO_SHOW, source MANUAL|IA) y `FollowUp` (recordatorios con vencimiento). `GET /ops/executive` = el "bot jefe" de la landing calculado en vivo: áreas auditadas OK/atención, semana vs semana, ahorro estimado en sueldos (params `Company.savingsSalaryUsd` + `agentCapacityPerMonth`, editables en Configuración) y pendientes accionables. Páginas: `/app/agenda`, `/app/gerencia`; modales de cita/seguimiento reutilizados en la bandeja; Dashboard con saludo + checklist "Primeros pasos" + tira de agenda; Contactos con vista tablero y export CSV
- `jobs` — **crons** (@nestjs/schedule): facturación mensual (día 1 06:00, mes anterior por empresa ACTIVE = plan + WhatsApp + storage, idempotente) y reporte diario a gerencia por correo (07:00, usa `ExecutiveService.build` + `EmailsService.systemSend`; encola sin SMTP). Disparos manuales `POST /jobs/invoices?period=` y `POST /jobs/executive-emails` (plataforma) — botones en Dev Tools → Operación
- `twilio` — **WhatsApp vía Twilio** (Fase 3 Nexus): colas BullMQ/Redis (`src/queue/queue.module.ts`; Redis por brew services). Webhooks públicos `POST /webhooks/:slug/twilio` y `/status` con firma X-Twilio-Signature validada contra el setting `WEBHOOK_BASE_URL` — 200 inmediato, trabajo a cola. Idempotente por MessageSid. Multimedia a `uploads/`. Envío: ventana 24h (fuera → contentSid de plantilla o falla con alerta), categorías Meta + costo por mensaje (`Message.metaCategory/metaCostUsd`, tarifas en `orderConfigJson.metaRatesUsd`), estados por callback, 5 reintentos backoff; fallo final → FAILED + needsAttention + audit `twilio.send_failed`. **Credenciales por línea cifradas** (`src/common/crypto.ts`, AES-256-GCM con `MASTER_ENCRYPTION_KEY` en .env): el front manda `config.authToken` una vez, se guarda `authTokenEnc`, jamás sale del API (serialize expone `twilioConfigured`). **Sandbox por línea** (`config.sandbox: true`): nunca sale mensaje real (Nexus está así). El motor encola sus respuestas a wa-outbound con delays; jobIds de BullMQ SIN `:` (usar `-`)
- `orders` + `catalog` — **módulo de pedidos** (Fase 4 Nexus): transiciones explícitas `ORDER_TRANSITIONS` (jamás saltar estados; trazabilidad hasta despacho, SIN ruta), motor de reglas `resolveArea` (producto/categoría/cantidad/prioridad, config en `orderConfigJson.distributionRules`), agenda `validateAgenda` (reglas puras en `src/common/agenda.ts` + corte `violatesCutoff` + capacidad por franja + alternativas), pipeline de confirmación (distribuye→agenda→recordatorios→programado; agenda inválida → requiere_atencion), Recordatorios idempotentes (creación por pedido + job cada minuto con claim updateMany condicional, 3 reintentos → FALLIDO + audit; WHATSAPP proactivo exige plantilla Meta salvo sandbox), vista por área (dirección solo despacho/logística; rol `COMPANY_AREA` clavado a su área), calendario, edición con traza + `correctedAfterAi`. CRUD catálogo en `/catalog/*` y `/customers` (presentaciones de productos normalizadas a `string[]`). **Panel (Fase 5)**: páginas `/app/orders` (tabla filtrable + calendario con capacidad), `/app/orders/:id` (detalle: ítems por área, historial, recordatorios, feedback, transiciones válidas con motivo obligatorio al cancelar, edición manual → marca `correctedAfterAi`), `/app/orders/settings` (tabs: productos, áreas, reglas de distribución, agenda/franjas/festivos, plantillas de recordatorio `orderConfig.reminderTemplates`, base de conocimiento `orderConfig.knowledgeBase` — FAQs que el motor mete al prompt), `/app/customers` (fichas) y `/app/area` (tarjetas + marcar listo). **Nav por módulos**: Pedidos/Clientes/Vista por área solo si `Company.modules` incluye `orders` — así se aprovisiona otra empresa tipo Nexus sin tocar código. Rol `COMPANY_AREA` entra directo a `/app/area` y no ve nada más (guard `BlockArea` en App.tsx + 403 del API). ⚠️ **Prisma+Mongo: usar `NOT_DELETED` (constants) — `deletedAt: null` NO matchea campos ausentes (isSet)**
- `reports` — **reportes + consulta + feedback** (Fase 6 Nexus): `GET /reports/daily?date` (calculado en vivo: pedidos por transición del día vía OrderStatusHistory, conversaciones atendidas/IA/escaladas/humano, dudas de la IA con motivo, alertas accionables y **precisión IA real** = pedidos IA sin `correctedAfterAi` / total, día y mes); cron cada hora genera+envía el del día anterior a la hora local de `orderConfig.dailyReport {hour, channel PANEL|EMAIL, email}` y lo persiste (`DailyReport` @@unique companyId+date, historial en `GET /reports/history`, disparo manual `POST /reports/daily/run`). `GET /reports/compare?granularity=week|month` (volumen, cumplimiento = entregas pasadas que llegaron a entregado, evolución de precisión). **`POST /reports/ask`** = consulta en lenguaje natural con 8 HERRAMIENTAS PREDEFINIDAS (jamás SQL/texto del usuario a la base; params validados con whitelist/regex/clamp; tenant-scoped; devuelve answer + tool + data de respaldo; 2 llamadas a DeepInfra registradas en AiUsageEvent; sin llave → 400 claro). `GET /reports/feedback` = resumen: promedio, distribución, tasa de respuesta, testimonios positivos (uso comercial) y negativos. **Feedback post-entrega**: `changeStatus → entregado` llama `RemindersService.scheduleFeedback` (Reminder kind FEEDBACK + registro `Feedback` con `requestedAt = ahora + orderConfig.feedbackDelayHours`, idempotente por orderId único); la respuesta del cliente se captura DETERMINISTA en `TwilioService.captureFeedback` (antes del motor, no pasa por IA; parser en `src/common/feedback.ts`: rating dígito/palabra/estrellas + sentimiento por reglas); insatisfacción (rating ≤3 o sentimiento negativo) → `alerted` + needsAttention + botPaused + audit `feedback.alert` + SSE. ⚠️ buscar pendientes por `status: 'PENDIENTE'`, NO `respondedAt: null` (Mongo isSet). Página `/app/orders/reports` (4 pestañas). Fechas "hoy": usar `localToday()` (Intl en-CA), NUNCA `toISOString().slice(0,10)` (a la noche en Bogotá ya es mañana en UTC)
- `marketing` — **contenido y campañas** (módulo activable `marketing` por empresa): `MarketingCampaign` (canales/fechas/presupuesto) y `ContentPiece` (REEL/POST/STORY/AD con estados IDEA→…→PUBLICADO, copy/hashtags/guion, calendario). `POST /marketing/pieces/:id/generate-copy` = copy+hashtags+guion con la IA de la empresa (BYOK, consumo a AiUsageEvent, whitelists en todos los enums). **Gancho MoneyPrinterTurbo** (repo en `~/proyecto 5/MoneyPrinterTurbo`, API FastAPI :8080): con `MPT_BASE_URL`/`MPT_API_KEY` en Dev Tools → Settings, `POST /marketing/pieces/:id/render-video` encola el reel (`POST /api/v1/videos`, guion=narración, 9:16, header x-api-key) y un cron cada 30 s hace polling de `/api/v1/tasks/:id` (state 1=ok/-1=fail, progress) y guarda el video en la pieza (`VideoJob`); sin configurar → 400 con mensaje claro. Página `/app/marketing`
- **Aprovisionamiento sin código**: `POST /companies` acepta `templateId` (`company-templates.ts` — catering=paquete Nexus completo con orderConfig+4 áreas+bot+línea Twilio sandbox; webcam; servicios) o `cloneFromCompanyId` (copia módulos/agenda/catálogo con áreas remapeadas/bots DRAFT/líneas — JAMÁS credenciales, llaves ni datos; sandbox forzado), MÁS personalización del wizard: `currency`, `orderConfigOverrides` (merge sobre la base), `areas[]` (reemplazan las de la plantilla, canal whitelisted) y `personaTemplateId` (el bot nace con esa personalidad de la biblioteca; el prompt escrito a mano manda). `GET /companies/templates` expone la base editable (orderConfig+areas) para el wizard. Wizard (CompanyNew.tsx): 8 pasos dinámicos por clave (paso "Agenda y áreas" solo con módulo orders), navegación clickable a pasos visitados, resumen con "Editar" por dato, vista previa de marca en vivo, generador de contraseña y pantalla de éxito con credenciales copiables
- **PDFs y correos con marca**: `src/common/pdf.ts` (pdfkit, fuentes estándar — ⚠️ sin glifos unicode tipo →, usar ASCII): `GET /orders/:id/pdf` y `GET /reports/daily/pdf` con banda del brandColor. Correos del sistema (`EmailsService.systemSend`) envueltos en `brandLayout` (branded:false para crudo). Front: `openPdf()` en lib/api.ts (blob+JWT)
- **Pedidos manuales**: `POST /orders` (COMPANY_ADMIN) con `confirm:true` → mismo pipeline que la IA; `takenByType HUMANO` + trazabilidad. Modal "Nuevo pedido" en /app/orders
- **Tour de bienvenida**: `components/Tour.tsx` (sin librerías, pasos por rol anclados a `[data-tour]` del AppShell), se muestra hasta `User.tourDoneAt` (POST /auth/tour-done); pasos de módulos no contratados se saltan solos
- **Seguridad endurecida (Fase 7)**: login con bloqueo por cuenta (5 fallos → 15 min, `failedLogins/lockedUntil`, audit `auth.lockout`), anti-enumeración (hash señuelo + mensaje idéntico); **RolesGuard: COMPANY_AREA solo entra a endpoints con @Roles que lo incluyan** (+ /api/auth/*), también bloqueado del SSE; integrations.serialize NUNCA devuelve configJson crudo (fuga corregida). Suites: `test/security.spec.ts` (ataques por servicio), `test/e2e-security.mjs` (42 checks HTTP vivos), `test/integration.spec.ts` (flujo completo + fallos simulados + idempotencia), `test/load-test.mjs` (carga; 429 = protección, no caída). Checklist de salida: `LANZAMIENTO.md`
- `webhooks` — **receptor WhatsApp Cloud API** público (`@SkipThrottle`): `GET /webhooks/:slug/whatsapp` verifica hub.challenge contra `META_VERIFY_TOKEN` (Dev Tools); `POST` ingiere mensajes: matchea línea por `phone_number_id`, upsert de contacto por teléfono, conversación abierta o nueva, mensaje IN y `needsAttention: true` (hasta que exista el motor). Devuelve 200 siempre
- `auth` además: `POST /auth/change-password` (self-service, cualquier rol; botón en el sidebar)
- `engine` — **motor conversacional** (Fase 2 Nexus): capa `src/ai/` agnóstica (AiProvider → DeepInfraProvider, chat JSON-mode + Whisper; SIEMPRE DeepInfra salvo orden contraria del usuario). Contrato `EngineOutput` validado a mano con reintento→escala. Contexto: personalidad efectiva línea/bot, reglas de agenda (`orderConfigJson`), catálogo, ficha Customer + últimos 3 pedidos, borrador acumulado. Umbral de confianza (`aiConfidenceThreshold` default 0.8) → escala (needsAttention+botPaused, pedido a requiere_atencion, auditoría `engine.escalate`). Confirmación explícita obligatoria + guard de agenda (`validateDelivery`). Humanización `humanizeDelays` + debounce de agrupación en memoria (→BullMQ en Fase 3). Simulador `POST /engine/simulate` (canal SIMULATOR, bot DRAFT permitido). **Jest**: `pnpm --filter @backoffice/api test` — 21 pruebas en `test/engine.spec.ts` con mock-prisma y proveedor guionado
- `audit` — AuditService global; todas las mutaciones importantes loguean
- `devtools` — panel técnico con 6 pestañas: **Salud** (`GET /dev/status`: latencia Atlas, colas BullMQ con contadores + `POST /dev/queues/retry-failed`, conexiones SSE, memoria/uptime, checklist de settings por grupo con faltantes), **Simulador** (`POST /dev/simulate-inbound`: inyecta mensajes por el flujo real del webhook — SOLO líneas sandbox, 400 contra producción), **Logs** (`GET /dev/logs`: ring buffer de 500 warn/error vía `BufferedLogger` en main.ts — `src/common/log-buffer.ts`), utilidades `POST /dev/test-email` y `POST /dev/test-deepinfra` (prueba la llave BYOK de una empresa con ~5 tokens), Operación (jobs manuales), Settings (META_*, WOMPI_*, SMTP_*, MPT_*, WEBHOOK_BASE_URL, USD_COP_RATE) y API keys (secreto mostrado una sola vez)

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

Cuentas reales (contraseñas en `apps/api/.env` como `SEED_PASSWORD_*` — jamás en el código; los seeds y los tests E2E las leen de ahí;
la vieja `backoffice2026` ya no existe):
- `santiago@backoffice.dev` / `daniel@backoffice.dev` — SUPER_ADMIN
- `restrepos591@gmail.com` / `danielloaiza609@gmail.com` — DEV (fundadores)
- `admin@empresa-prueba.com` — COMPANY_ADMIN de la Empresa de Prueba (vacía)

## Agente con herramientas, domicilios e IA revendida (oct 2026, rama agentes-domicilios)

- **Dos motores por bot** (`Bot.engineMode`): `ORDERS` = extracción estructurada de
  Nexus (sin cambios) · `AGENT` = agente con herramientas (`src/ai/agent/`). Protocolo
  JSON-mode agnóstico del proveedor (`protocol.ts`): el modelo devuelve
  `{"tool_calls":[…]}` o `{"reply":[…],"confidence"}`; bucle de máx. 6 pasos
  (`agent.service.ts`), salida validada, 2 inválidas → escala, umbral de confianza.
- **Herramientas** (`tools.ts`, todas tenant-scoped y con params validados, jamás
  SQL): ver_menu, ver_horarios, ver_cliente, calcular_envio, armar_pedido (reemplaza
  el borrador; NO inventa productos → `no_encontrados`), confirmar_pedido (exige
  `cliente_confirmo: true` + agenda + ubicación si hay domicilios → pipeline de
  confirmación + link de seguimiento), estado_pedido, cancelar_pedido (solo
  borrador/confirmado/programado), guardar_direccion, pasar_a_humano (siempre).
  Permisos por bot en `Bot.toolsJson` ([{tool, access}]; las de escritura exigen
  write) y plantillas `AGENT_PRESETS` (domicilios / pedidos_programados /
  solo_consultas). `GET /bots/agent-catalog`. UI: BotDetail → pestañas Agente y Probar
  (simulador con "compartir ubicación").
- **Ubicación por WhatsApp**: Twilio manda Latitude/Longitude → `Message.type
  LOCATION` + latitude/longitude (`parseSharedLocation`). El simulador acepta
  `latitude/longitude`. La bandeja la muestra con link a Maps.
- **Geo** (`src/common/geo.ts`): haversine × factor de calle (1,35), costo por
  base + km (redondeo COP a la centena), cobertura, ETA = preparación + viaje.
  Geocodificación: Google si hay `GOOGLE_MAPS_API_KEY` (recomendado: OSM ubica
  direcciones colombianas solo a nivel de barrio), si no Nominatim. Config en
  `orderConfig.delivery` {enabled, origin, maxKm, baseFee, perKm, minFee,
  freeFromSubtotal, prepMinutes, avgSpeedKmh}; UI: Pedidos → Configuración →
  Domicilios (ubicar punto de despacho, probar cotización). `Product.price`.
- **Domicilios** (`delivery.module.ts`): tablero `GET /delivery/board` (página
  `/app/deliveries`, mapa Leaflet vendorizado en `apps/web/src/vendor/leaflet` con
  teselas OSM filtradas a la paleta), asignación `POST /delivery/orders/:id/assign`,
  app del domiciliario `/courier` (turno, `POST /delivery/me/location` cada ~10 s con
  Wake Lock, recoger → empacado → despachado, entregar con foto opcional). Rastro en
  `CourierPing` (sin relación a Company: se borra aparte; cron 03:00 depura 7 días y
  cierra turnos olvidados). Al pasar a `despachado` se avisa al cliente por su chat
  ("va en camino" + link; fuera de 24 h solo con plantilla `pedido_en_camino`).
  El nav muestra Domicilios con el módulo `delivery` o `orderConfig.delivery.enabled`.
- **Seguimiento público** `/t/<token>` (`GET /api/public/track/:token`, @Public,
  throttled): marca de la empresa, línea de tiempo, mapa con domiciliario, total.
  Sin ids internos ni teléfonos del equipo; a las 72 h de entregado oculta el
  detalle. Token aleatorio en `Order.trackingToken` (se crea al programar).
  Base del link: `PUBLIC_WEB_URL` (Dev Tools) → WEBHOOK_BASE_URL si no es el
  puerto del API → CORS_ORIGIN → localhost:5173.
- **IA revendida e híbrida** (`src/ai/ai-access.ts`, punto ÚNICO para motor/agente/
  reportes/marketing/devtools; las dos cuentas son DeepInfra): `Company.aiBillingMode`
  BYOK (llave propia, ahora CIFRADA con MASTER_ENCRYPTION_KEY; texto plano legado se
  sigue leyendo), PLATFORM (llave de BackOffice: `DEEPINFRA_API_KEY` en .env o Dev
  Tools → Settings) o **HYBRID** (las dos: `aiHybridPrimary` decide cuál va primero;
  si no está disponible —sin llave, tope— arranca con la otra, y si DeepInfra la
  rechaza a mitad de corrida —401/402/403, `AiProviderError.providerStatus`— la
  `AiSession` pasa a la de respaldo y se queda con ella; audit `ai.fallback`).
  `Bot.aiSource` (INHERIT|BYOK|PLATFORM|HYBRID, solo plataforma lo cambia) permite
  venderle a la empresa UN asistente con la IA de BackOffice. Cada llamada registra
  quién pagó (`billedTo`); solo lo PLATFORM cuenta para incluidas/excedente. El
  agente con el proveedor caído escala (antes podía quedar sin respuesta). `AiUsageEvent`
  guarda `billedTo` y `conversationId`; "conversación IA" = conversación distinta
  del mes. Plan: `includedAiConversations` + `extraAiConversationUsd`; empresa:
  `aiIncludedOverride`, `aiSpendCapUsd` (tope duro: con el tope alcanzado la IA no
  llama al modelo y escala + audit `ai.cap_reached`). El excedente entra en la
  factura mensual y en `/billing/summary`. Solo plataforma cambia estos campos.
- Plantilla de empresa `domicilios` (almuerzos/restaurantes) en company-templates:
  bot nace en modo AGENT. Demo Delicias Andinas: precios, coordenadas reales de
  Medellín, 2 domiciliarios (`andres@deliciasandinas.co` en ruta con rastro GPS),
  segundo asistente "Tomás · Domicilios" en modo agente, pedido en camino con link.
- Tests: `test/agent.spec.ts` (29). Rutas web con `lazy()` (el link público no
  baja el panel: index 314 KB vs 1,2 MB antes).

## Crecimiento, cobro y operación (oct 2026, rama agentes-domicilios)

- **Precios** (`pnpm --filter @backoffice/api db:seed:precios`, idempotente): línea
  Negocios en COP (Esencial 149k · Negocio 349k · Operación 890k, montaje gratis con
  permanencia 6/6/12 meses; salida anticipada = montaje proporcional, SETUP adjustment
  salvo `waiveSetupFee`). Planes Pro USD siguen (precio por revisar con el usuario).
  Prueba gratis: eliminada a pedido del usuario.
- **Cobro mes a mes** (`src/common/billing-engine.ts`, `billing.module.ts`): precio
  propio (`Company.customPriceMonthly`) + `BillingAdjustment` (PRICE/CHARGE/DISCOUNT/
  SETUP; un mes, rango o recurrente; % o valor). Facturas editables (solo plataforma),
  proyección `GET /billing/forecast`. UI: Empresa → pestaña Cobro (`CompanyBilling.tsx`).
- **IA prepaga**: `AiCreditPackage` (500/2k/5k/15k), lotes FIFO `AiCreditLot` con
  vencimiento de 12 meses, 1 crédito por conversación cada 24 h; primero las incluidas
  del plan; alertas 80 %/100 % (`ai.credits` por SSE). Compra con Wompi, regalo desde
  plataforma (`POST /ai-credits/grant`).
- **Campañas** (`campaigns.module.ts`, `/app/campaigns`): segmento → vista previa con
  costo Meta → envío escalonado con claim atómico; fuera de 24 h solo con plantilla.
  Bajas SALIR/ACTIVAR (`Contact.optOut`). Seguimiento automático en
  `orderConfig.followUps`. Reseña de Google tras calificación ≥4.
- **Pedidos**: cobro en el chat (Wompi de la empresa, secretos cifrados, webhook
  `/payments/wompi/:slug/events`), comprobante leído por IA (`src/ai/vision.ts`) →
  REPORTED, nunca PAID solo. Comanda `/print/order/:id` (80/58 mm). Cupones y promos
  (`promotions.ts`), agotados (`Product.soldOut[Until]`), fotos de producto, menú
  público `/m/:slug` + QR (`src/common/qr.ts`, encoder propio). Factura DIAN
  (`einvoice.ts`: ALEGRA o SIMULADO). Pedidos externos `POST /api/inbound/orders`
  con API key de scope `orders`; idempotencia con candado único `InboundOrderKey`
  (reintentos simultáneos → un solo pedido).
- **Domicilios 2.0**: zonas por barrio (`pricingMode: ZONES`), sucursales (`Branch`,
  sale de la más cercana), asignación automática al quedar listo, alertas de retraso
  y sin domiciliario (cron 2 min), ruta sugerida con orden y link de Google Maps.
- **CRM**: embudos configurables (`Pipeline`; contactos sin el campo = embudo
  estándar: Mongo exige `OR [null, isSet:false]`), respuestas rápidas ("/" en la
  bandeja), base de conocimiento por texto/URL/PDF (BM25, SSRF bloqueado; PDF necesita
  `pdftotext`, no existe en Render), configuración del negocio con IA (`/ai-setup`).
- **Instagram/Messenger** por Graph API: Integraciones → Conectar (pageId, igUserId,
  token cifrado, sandbox). Webhook `/api/webhooks/<slug>/meta`, firma con
  `META_APP_SECRET` (Dev Tools → Settings).
- Modelos SIN relación a Company (promos, respuestas, conocimiento, embudos, campañas,
  ajustes, saldo IA, pings, candados): al borrar una empresa los limpia
  `src/common/company-cleanup.ts` (panel y demo lo usan).
- API keys: el listado nunca devuelve `hash`; scopes permitidos read/write/orders.
- Tests: billing/growth/operations/agent/devtools specs (275 en total) +
  `node test/e2e-growth.mjs` (API viva: empresa y devs en paralelo sobre una empresa
  de prueba que el script crea y borra con el super admin; 52 checks).
- UI: `Switch showLabel` muestra el texto al lado; la animación de página usa
  `backwards` (con `both` quedaba un transform que recortaba los modales).

## Pendiente

1. Revisar precios de los planes Pro en USD con el usuario (competencia).
2. Probar el adaptador de Alegra con una cuenta real (hoy validado en SIMULADO).
3. Hosting 24/7 (Render/Vercel planeado): `/api` relativo en la web, Redis con
   TLS (`redisConnection` no soporta rediss:// ni usuario), `trust proxy`,
   `uploads/` a almacenamiento externo, `pdftotext` no existe en Render.
4. Llaves reales de Wompi + SMTP + Meta (app review para Instagram/Messenger).
5. Suscripciones semanales de almuerzos (pedidos recurrentes).

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
