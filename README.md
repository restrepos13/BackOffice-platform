# BackOffice Platform

CRM multi-tenant para que empresas consuman los servicios de BackOffice:
chatbots con IA, automatizaciones de contenido y automatizaciones en general.
Diseño editorial brutalista tomado de la landing
([backoffice-alpha-jade.vercel.app](https://backoffice-alpha-jade.vercel.app)):
hueso `#E6E1DD` / tinta `#1A1A1A`, Anton + Playfair Display + Geist.

## Stack

- **Monorepo pnpm** — `apps/api` + `apps/web`
- **API**: NestJS + Prisma. Hoy corre sobre **SQLite** (desarrollo); cuando se
  defina la base final solo hay que cambiar `provider` en
  `apps/api/prisma/schema.prisma` y `DATABASE_URL` en `apps/api/.env`.
- **Web**: React 18 + Vite + Tailwind 4 + TanStack Query + Recharts + sonner.

## Arranque

```bash
pnpm install
pnpm db:push      # crea la base (SQLite dev)
pnpm db:seed      # datos demo
pnpm dev          # api en :4001 + web en :5173
```

## Roles

| Rol | Alcance |
|---|---|
| `SUPER_ADMIN` | Vos y tu socio. Panel de plataforma completo + entrar al panel de cualquier empresa. |
| `DEV` | Igual que super admin en plataforma, pensado para el desarrollador (Dev Tools, API keys, salud del sistema). |
| `COMPANY_ADMIN` | El dueño de la empresa cliente: métricas, bots, integraciones, equipo, facturación, configuración. |
| `COMPANY_VIEWER` | Solo visualización: ve todo el panel de su empresa, sin poder editar nada. |

## Usuarios demo (contraseña: `backoffice2026`)

- `santiago@backoffice.dev` / `daniel@backoffice.dev` — SUPER_ADMIN
- `dev@backoffice.dev` — DEV
- `admin@massaludlatam.com` · `vista@massaludlatam.com` — Mas Salud Latam (Growth, activa, 2 líneas WA)
- `admin@hmmotors.net` · `vista@hmmotors.net` — HM Motors (Starter, activa)
- `admin@lotesancestral.com` — Lotes Ancestral (trial)
- `admin@novastudio.co` · `monitor@novastudio.co` — Nova Studio (agencia webcam, 4 líneas con personalidad propia)

## Qué incluye

**Panel de plataforma** (`/platform`): resumen con MRR/consumo/actividad global,
gestión de empresas con **wizard de aprovisionamiento en 6 pasos** (datos, plan y
límites con overrides, módulos habilitables, admin inicial, bot inicial y canales
preparados), ficha de empresa con tabs (config, plan/módulos, usuarios, bots,
integraciones, auditoría, zona de riesgo con suspensión/borrado), editor de
planes (Starter/Growth/Scale/Enterprise de la landing), gestión global de
usuarios, auditoría completa y Dev Tools (salud del sistema, API keys con
secreto de un solo uso, credenciales Meta).

**Panel de empresa** (`/app`): dashboard con KPIs y gráficas, bandeja de
conversaciones con chat e intervención humana (handoff), CRM de contactos con
embudo curioso→potencial→caliente→cliente, editor de asistentes IA
(personalidad, modelo, temperatura, memoria, handoff, canales), automatizaciones
con ejecuciones y tasa de éxito, integraciones con botón **Conectar** (links de
OAuth Meta ya armados — sin credenciales guardadas), analytics 30 días,
facturación con la composición de la landing (tarifa fija + consumo al costo =
mensualidad) e historial de facturas, equipo con invitaciones y configuración.

Los roles de plataforma tienen un selector "Panel de empresa" en el sidebar para
entrar al panel de cualquier tenant.

## Líneas WhatsApp (varios números por empresa)

Cada empresa puede tener N números de WhatsApp ("líneas") — un número por
modelo/perfil (estudios webcam), por área (clínicas) o por campaña. Cada línea
elige cómo responde su IA:

- **Hereda del bot**: usa las instrucciones generales del bot asignado.
- **Personalidad propia**: prompt, tono, estilo, límites, bienvenida, handoff y
  hasta modelo/temperatura de IA propios de ese número — 100% personalizable.

Extras: **clonar línea** con toda su personalidad, **ranking de líneas** en
Analytics (mensajes, conversaciones, alertas por número = "analytics por
modelo"), y filtro por línea en la bandeja de conversaciones.

## Biblioteca de personalidades (diferenciador)

Plantillas de personalidad listas para aplicar a un bot o a una línea con un
clic (recepcionista de clínica, asesora de estudio webcam, vendedor automotriz,
inmobiliaria, cobranza…). Las globales se gestionan en
**Plataforma → Personalidades**; cada empresa puede guardar las suyas desde el
editor de línea ("Guardar como plantilla"). Onboarding de un cliente nuevo en
minutos.

## Pagos por suscripción (Wompi — Colombia)

- **Checkout**: botón "Pagar con Wompi" en Facturación genera el Web Checkout
  (`checkout.wompi.co`) con firma de integridad SHA-256 y conversión USD→COP
  (tasa configurable).
- **Validación**: webhook `POST /api/payments/wompi/events` verifica la firma
  de eventos (`WOMPI_EVENTS_SECRET`); un evento `APPROVED` marca el pago y la
  factura como pagados. Firma inválida → 401.
- **Config**: llaves en Dev Tools → Pasarela Wompi (public key, integrity
  secret, events secret, ambiente test/producción, tasa USD→COP).
- **Internacional**: pendiente (provider reservado en el esquema para Stripe).

## Correos a empresas

**Plataforma → Correos** (solo SUPER_ADMIN/DEV): redacta correos personalizados
con variables `{{empresa}}`, `{{plan}}`, `{{contacto}}` y plantillas rápidas
(bienvenida, resumen mensual, factura pendiente). Envío por SMTP configurable en
Dev Tools; sin SMTP los correos quedan **en cola** y se reenvían con un clic
cuando haya credenciales. Historial completo con estado y vista previa.

## Integraciones Meta

Los links de conexión (WhatsApp / Instagram / Messenger / Meta Ads) se generan
con `META_APP_ID` — configurable desde **Dev Tools → Credenciales de conexión**
o en `apps/api/.env`. Mientras no exista la app de Meta quedan como placeholder;
al llenar el App ID, los botones "Conectar" de todas las empresas apuntan al
OAuth real. No se guarda ninguna cuenta ni token en esta fase.

## Modelos IA (DeepInfra) y costos declarados

El catálogo de modelos vive en **Plataforma → Modelos IA** (tabla `AiModel`):
cada modelo con su costo USD por millón de tokens de entrada/salida, que el
cliente ve tal cual en **Facturación → Costos de los modelos IA** (consumo al
costo, sin margen). Los precios sembrados son de referencia — mantenerlos al
día contra deepinfra.com/pricing. `DEEPINFRA_API_KEY` se configura en Dev Tools.

## IA 100% personalizable (por bot y por línea)

- **Personalidad**: prompt, tono, estilo, límites, bienvenida, handoff.
- **Motor**: modelo del catálogo DeepInfra y temperatura, por bot o por línea.
- **Tiempos de respuesta humanizados**: espera aleatoria entre mín. y máx.
  segundos + simulación de "escribiendo…" (config por bot, override por línea).
- **Habilidades de venta (chatter)**: objetivo, estilo de venta, catálogo y
  precios, reglas de upsell y manejo de objeciones — por bot y override por línea.

## Galería de medios

La empresa carga fotos (JPG/PNG/WebP/GIF, máx. 10 MB) para que la IA o un
agente las envíe en el chat. Cada imagen tiene precio (PPV), etiquetas, línea
asignada y contador de envíos. Los archivos se guardan con nombre aleatorio en
`apps/api/uploads/<companyId>/` y se sirven SOLO por endpoint autenticado con
control de tenant. En la bandeja hay botón de "enviar foto" con picker.

## Seguridad

- Rate limiting global (200 req/min/IP) y anti fuerza bruta en login (10/min → 429).
- Helmet (X-Frame-Options, nosniff, sin X-Powered-By) y límite de payload 1 MB.
- JWT con secreto fuerte en `.env` (no commiteado; hay `.env.example`); si falta,
  el server genera uno efímero en vez de arrancar con secreto conocido.
- Aislamiento multi-tenant verificado en cada módulo (`scopeCompanyId`), incluidos
  archivos de galería y fotos en conversaciones cruzadas (403).
- Webhook Wompi: firma de eventos obligatoria fuera del ambiente test.
- Uploads: solo imágenes, mimetype validado (SVG rechazado por XSS), nombre
  aleatorio, sin servir estáticos.
- Suite de verificación: `python3 scratchpad/test_full.py` (42 checks E2E +
  seguridad; requiere API corriendo y seed fresco).

## Pendiente (fase 2)

- Base de datos definitiva (cambio de una línea en Prisma).
- Webhooks reales de WhatsApp/Meta y motor de respuesta IA.
- Callback OAuth de Meta (`/integrations/meta/callback`).
- Pasarela internacional (Stripe) — el esquema ya lo contempla.
- Llaves reales de Wompi y cuenta SMTP (se cargan en Dev Tools, sin tocar código).
