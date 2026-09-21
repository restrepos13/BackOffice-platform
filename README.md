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

## Pendiente (fase 2)

- Base de datos definitiva (cambio de una línea en Prisma).
- Webhooks reales de WhatsApp/Meta y motor de respuesta IA.
- Callback OAuth de Meta (`/integrations/meta/callback`).
- Pasarela internacional (Stripe) — el esquema ya lo contempla.
- Llaves reales de Wompi y cuenta SMTP (se cargan en Dev Tools, sin tocar código).
