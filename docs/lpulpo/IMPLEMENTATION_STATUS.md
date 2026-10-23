# Piloto LPulpo: estado de la implementación

Fecha: 23-oct-2026. Rama local `creative-ads`, sin push ni despliegue.

## Qué se implementó

El módulo **Producciones**, dentro de Automation. La producción es la unidad central: cliente, brief, recursos, disponibilidad, cotizaciones, tareas, incidencias e historial.

| Pieza | Dónde |
|---|---|
| Reglas puras: estados, permisos, brief, cotizaciones, tramos | `apps/api/src/common/productions.ts` |
| Servicio y endpoints | `apps/api/src/modules/productions/productions.service.ts`, `productions.module.ts` |
| Motor de Automation | `apps/api/src/modules/productions/workflow.service.ts` |
| Estado de integraciones con evidencia | `apps/api/src/modules/productions/integrations-status.ts` |
| Esquema (13 colecciones nuevas y `User.opsProfile`) | `apps/api/prisma/schema.prisma` (al final) |
| Pantallas | `apps/web/src/pages/company/productions/` (Home, List, Detail, Resources, Settings) |
| Entorno aislado | `apps/api/scripts/pilot-env.cjs`, `apps/api/prisma/pilot-bootstrap.ts`, `apps/api/prisma/pilot-e2e.ts` |

**Qué se reutiliza:**
- `Customer`, `Contact` y `Conversation` (una producción puede crearse desde una conversación).
- `User` y `Company`.
- `AuditLog` para acciones críticas.
- `AiUsageEvent`: costo de IA de la conversación ligada.
- BullMQ y Redis.
- El `ProductsGuard` (exige Automation).

**Qué no se reutilizó:**
- El módulo «Flujos y reglas» (`Automation`) era solo configuración. Se dejó intacto y el motor real es nuevo (`WorkflowRun`).
- `Appointment` modela citas de un solo espacio. Las reservas de producción usan su propio candado (`ProductionSlotLock`), porque admiten varios recursos y retenciones con vencimiento.

## Endpoints

Todos están bajo `/api/productions` y exigen Automation. La empresa se toma de la sesión; el `companyId` de la consulta solo cuenta para roles de plataforma.

- **Inicio y solicitudes:**
  - `GET /overview`
  - `GET /` (búsqueda, filtros, orden y paginación)
  - `POST /` (crear)
  - `POST /from-conversation` (idempotente por conversación)
- **Una producción:**
  - `GET /:id`
  - `PATCH /:id`
  - `PUT /:id/brief`
  - `POST /:id/transition`
- **Tareas:** `POST /:id/tasks` y `PATCH /tasks/:id`
- **Incidencias:** `POST /:id/issues` y `POST /issues/:id/resolve`
- **Recursos de una producción:**
  - `POST /:id/assignments` y `PATCH /assignments/:id`
  - `POST /assignments/:id/availability`
  - `POST /assignments/:id/hold`
  - `POST /assignments/:id/request-confirmation`
  - `POST /assignments/:id/confirm`
  - `POST /assignments/:id/release`
- **Cotizaciones:**
  - `POST /:id/quotes` (nueva versión)
  - `PUT /quotes/:id` (solo borrador)
  - `POST /quotes/:id/submit`
  - `POST /quotes/:id/decision` (aprobar o rechazar)
  - `POST /quotes/:id/mark-sent` (registra un envío hecho por fuera)
- **Catálogo:**
  - `GET /resources` y `POST /resources`
  - `PATCH /resources/:id`
  - `POST /resources/:id/rates`
- **Equipo, configuración, integraciones y motor:**
  - `GET /team` y `PUT /team/:userId`
  - `GET /settings` y `PUT /settings`
  - `GET /integrations` y `POST /integrations/whatsapp/validate`
  - `GET /runs`

## Qué funciona (probado)

- **Solicitudes:** se crean a mano; solo el cliente es obligatorio.
  - Código legible por empresa (`PR-0001`).
  - Canal de origen, contacto, responsable, prioridad, fecha y próxima acción con responsable y vencimiento.
- **Brief:** 18 campos.
  - La ficha muestra qué falta para darlo por completo y qué falta para cotizar.
  - La lista de obligatorios es configurable y está marcada como pendiente de confirmar.
- **Máquina de estados en el servidor:** 18 estados.
  - No se puede saltar estados ni cambiarlos con una actualización genérica.
  - Control de versión: dos personas no pisan el mismo cambio.
  - Exige motivo para pausar, perder o cancelar, y evidencia para la aceptación del cliente.
  - Al pausar guarda el estado anterior y al reanudar vuelve a él.
- **Recursos y disponibilidad:** catálogo por tipo con atributos y referencias a archivos (sin descargar nada).
  - La disponibilidad se registra a mano, con nota y fuente MANUAL.
  - Reservas: retención con vencimiento, pendiente de confirmación, confirmada, liberada y cancelada.
  - Candado por recurso y hora: dos producciones no retienen ni confirman el mismo tramo, incluso a la vez.
  - Solo se confirma con evidencia y después de que el cliente acepta.
- **Cotizaciones versionadas:**
  - Líneas con costo y precio, cada uno pendiente, estimado o confirmado.
  - Cada línea indica si va en el total, la paga el cliente aparte o está por definir.
  - Comisión por línea con porcentaje, base y líneas elegidas a mano.
  - Totales consistentes: si falta un valor, el total queda «incompleto».
  - Diferencias entre versiones.
  - Aprobación interna: aprobar es un permiso aparte y no se aprueba con valores pendientes.
  - Queda quién aprobó o rechazó, cuándo y por qué. La versión aprobada no se edita: se crea otra.
- **Tareas:** manuales y por regla, con dependencias (bloquean), responsable, vencimiento y origen trazable.
- **Incidencias:** se abren, impiden cerrar mientras sigan abiertas y se resuelven con explicación.
- **Historial de solo lectura:** no hay endpoint para editarlo ni borrarlo.
- **Motor de Automation real:**
  - Ejecuciones persistidas con clave idempotente y candado temporal contra ejecuciones simultáneas.
  - Reintentos limitados con espera exponencial y errores guardados.
  - Validación de empresa en cada ejecución.
  - Barrido cada 5 minutos que retoma ejecuciones abandonadas, marca tareas vencidas y libera retenciones vencidas.
  - Solo hace acciones internas.
- **Permisos por perfil** (`User.opsProfile`): Administración, Booker, Booker que aprueba, Finanzas, Operación y Consulta.
  - `COMPANY_VIEWER` sigue siendo de solo lectura salvo que un administrador le asigne otro perfil.
  - Los costos, márgenes y tarifas se ocultan sin el permiso financiero.
- **Interfaz:**
  - Inicio con conteos reales y estados vacíos.
  - Listado con búsqueda, filtros, orden y paginación.
  - Ficha con 8 secciones.
  - Catálogo de modelos y proveedores.
  - Configuración: parámetros pendientes, servicios y brief, tareas automáticas, usuarios y permisos, integraciones con evidencia, y motor con errores.

## Pruebas ejecutadas (resultados reales)

| Comando | Antes | Después |
|---|---|---|
| `cd apps/api && npx jest` | 34 suites, 644 pruebas OK | 35 suites, **670** OK (26 nuevas en `test/productions.spec.ts`) |
| `cd apps/web && npx vitest run` | 5 archivos, 48 OK | 6 archivos, **55** OK (7 nuevas) |
| `npx tsc --noEmit` (api y web) | OK | OK |
| `npm run build` (api y web) | OK | OK |
| `node scripts/pilot-env.cjs npx ts-node --transpile-only prisma/pilot-e2e.ts` | — | **26 de 26** comprobaciones contra la API y la base reales del piloto |

El proyecto no tiene un script de lint configurado.

## Qué es simulado o de prueba

- **Datos de las pruebas:** todos son ficticios y están marcados.
  - Las pruebas automáticas usan Prisma en memoria.
  - El recorrido E2E crea dos empresas de prueba en la base del piloto y las borra al terminar.
- **Registros que no son acciones reales:**
  - «Registrar envío» de una cotización solo deja constancia de que el booker la envió por su cuenta.
  - «Pendiente de confirmación» registra que se pidió la confirmación por fuera.
  - Nada sale de BackOffice.

## Integraciones

| Integración | Estado | Evidencia |
|---|---|---|
| WhatsApp | Código existente (Cloud API y Twilio), **no conectado** para LPulpo | Sin líneas ni credenciales en el piloto |
| Meta Ads (solo lectura) | Adaptador real de la Graph API, **no verificado** con una cuenta real | Sin cuenta conectada |
| Google Calendar | Código probado con un Google simulado, **sin credenciales OAuth** | Ver `docs/google-calendar.md` |
| Instagram y Messenger | Código de entrada y salida, **no conectado** | Falta revisión de la app de Meta |
| Formularios de Lead Ads | **No implementado** | — |
| Dropbox | **No implementado**; las fichas aceptan referencias manuales sin verificar | — |

La pantalla «Canales e integraciones» de Producciones muestra este estado con evidencia y nunca marca una integración como conectada sin datos reales.

## Limitaciones conocidas

- **IA:** no hay extracción del brief con IA; el brief se llena a mano.
- **Integraciones:** no se crean solicitudes solas desde WhatsApp ni Instagram. Sí se puede crear una desde una conversación existente, por API.
- **Calendario:** las reservas de producción no se sincronizan con Google Calendar.
- **Cotizaciones:** no hay PDF ni envío.
- **Búsqueda y listados:** se filtran en memoria (hasta 5.000 producciones por empresa), suficiente para el volumen del piloto.
- **Candado de recursos:** es por hora; un rango 9:30–10:00 ocupa la hora de las 9.
- **Términos de uso:** el primer ingreso de LPulpo muestra los términos y condiciones, que aún tienen campos por completar ([RAZÓN SOCIAL], [NIT]).

## Riesgos pendientes

- **Base de datos:** la base de desarrollo habitual es la de producción. El piloto corre en una base local aislada; desplegarlo exige definir dónde vivirá.
- **Índices:** las colecciones nuevas necesitan sus índices únicos (`prisma db push`) en cualquier base nueva. En la del piloto ya están.
- **Reglas comerciales:** sin las reglas de LPulpo, cada cotización se arma a mano (comisión incluida).

## Qué se puede probar hoy

El flujo completo en el entorno local del piloto, con cualquier registro marcado como prueba: crear una solicitud, asignar booker, completar el brief, agregar recursos, registrar disponibilidad y retener, cotizar en dos versiones, aprobar con un perfil aprobador, registrar el envío y la aceptación, confirmar recursos con evidencia, registrar una incidencia y ver el historial.
