# Motor de automatizaciones (Fase 2)

Estado: octubre 2026. Un solo motor: `WorkflowRun` + `WorkflowService` (el de Producciones), generalizado.

## 1. Componentes

| Pieza | Archivo | Rol |
|---|---|---|
| Definición v1 | `apps/api/src/common/automation/definition.ts` | Registros cerrados de disparadores, campos, operadores y acciones; `validateDefinition` (estricta), `evaluateConditions`, `catalog()` |
| Eventos de dominio | `apps/api/src/common/domain-events.ts` | `contactCreated`, `contactStageChanged`, `orderHistory(prisma).create` → `publishDomainEvent` |
| Señales del motor | `apps/api/src/common/automation/run-signals.ts` | `WaitUntil`, `PermanentError`, `CancelRun`, `deterministicId` |
| Motor (ejecución) | `apps/api/src/modules/productions/workflow.service.ts` | Reclamo con candado, reintentos, barrido; ahora con `registerHandler(kind)`, estado `WAITING`, `_id` determinista |
| Motor de automatizaciones | `apps/api/src/modules/automations/automation-engine.service.ts` | Evento → ejecuciones; ejecución paso a paso; acciones |
| API | `apps/api/src/modules/automations.module.ts` | CRUD, estados, versiones, simulación, historial, migración |
| Constructor | `apps/web/src/pages/company/Automations.tsx` | Lista, constructor, simulación, historial, migración |

## 2. Modelo
- `Automation`: `status` DRAFT | ACTIVE | PAUSED | ARCHIVED; `configJson` = **borrador** (puede estar incompleto, nunca se ejecuta); `triggerType`; `version` = última publicada; `createdById`.
- `AutomationVersion` (nuevo): snapshot **inmutable** `{_id: "<automationId>:v<n>"}`. Activar (o guardar una activa/pausada) valida y publica la versión siguiente. Cada ejecución guarda `automationVersion` y siempre corre esa versión, aunque la definición cambie después.
- `WorkflowRun` (+ campos opcionales): `automationId`, `automationVersion`, `triggerType`, `sourceType`, `sourceId`, `eventId`, `stepsJson`. `kind = automation.run`.
- `AutomationRun`: queda solo con datos del seed de demostración; el panel ya no lo lee. `runsCount`/`successRate` de `Automation` tampoco se muestran.

## 3. Lo soportado (y nada más)
**Disparadores**
| Tipo | Origen real | Configuración |
|---|---|---|
| `contact.created` | Panel, WhatsApp Cloud API, Twilio, reservas públicas, pedidos externos | — |
| `contact.stage_changed` | Panel (editar / tablero) y agente IA al confirmar pedido | `toStage` |
| `order.status_changed` | Los 11 registros de `OrderStatusHistory` (panel, IA, pedidos externos, confirmación) | `toStatus` |

No disparan (limitaciones documentadas): contactos del **simulador**, la migración masiva de etapas al editar un embudo (`pipelines.module`), y cualquier escritura que no pase por esos puntos.

**Condiciones**: lista plana (sin anidar), `all` o `any`, máx. 10. Operadores por tipo: texto (`eq, neq, contains, not_contains, exists, not_exists`), enumerado (`eq, neq, in, exists, not_exists`), número (`eq … lte`, sin coerción de texto), etiquetas (`contains, not_contains`), booleano (`is_true, is_false`). Sin fechas (no hay campos de fecha bien definidos en v1).

**Acciones** (todas internas, máx. 10, en orden)
| Acción | Efecto | Idempotencia |
|---|---|---|
| `create_follow_up` | `FollowUp` del contacto (tarea con vencimiento) | `_id` = hash(ejecución, paso) |
| `add_tag` / `remove_tag` | etiquetas del contacto | conjunto |
| `set_stage` | etapa (validada contra el embudo del contacto) | condicional (`updateMany` por etapa previa) |
| `assign_owner` | responsable (usuario activo de la empresa) | conjunto |
| `log_activity` | `AuditLog` `automation.activity` | `_id` = hash(ejecución, paso) |
| `wait` | pausa N horas (1–720) sin gastar intentos | paso guardado con `resumeAt` |
| `assign_courier` | `OrdersService.autoAssignCourier` (solo pedidos, solo si la migración está activa) | asignación condicional existente |

**No soportado (a propósito)**: enviar WhatsApp/correo, campañas, cobros, cambios de Ads. Requieren consentimiento, ventana de 24 h, plantillas y confirmación humana que el motor v1 no modela. El constructor no los muestra.

## 4. Idempotencia y recuperación
1. **Ejecución única por ocurrencia.** Clave: `auto:<automationId>:<eventId>` (o `auto:<automationId>:rec:<recordId>` con `once_per_record`). El `_id` del `WorkflowRun` es `sha256(empresa, clave)`; Mongo **siempre** impone `_id` único, así dos entregas simultáneas del mismo evento crean una sola ejecución aunque el índice `@@unique([companyId, idempotencyKey])` no exista en Atlas (verificado: hoy no existe).
2. **eventId**: contacto creado → id del contacto; estado de pedido → id del registro de historial; etapa → contacto + transición + ventana de 10 min (no hay historial de etapas; usa `once_per_record` si necesitas garantía total).
3. **Reclamo**: `updateMany` condicionado a estado y `lockedUntil` vencido (2 min). Dos workers no corren la misma ejecución; si un proceso muere, el barrido (cada 5 min) la retoma.
4. **Pasos**: tras cada acción se guarda `stepsJson`. Un reintento salta las acciones `DONE` y sigue desde la que falló. Los efectos que crean registros usan `_id` determinista, así un corte entre efecto y bitácora no duplica.
5. **Reintentos**: espera exponencial (2, 4, 8… min, tope 60) hasta `maxAttempts` (1–5, por automatización). `PermanentError` (dato inválido, recurso ajeno o borrado) falla de una vez.
6. **Esperas**: `WAITING` con `nextRetryAt`; la cola BullMQ programa un job diferido y el barrido es la red de seguridad.
7. **Pausa/archivo**: cancela lo `PENDING/RETRYABLE/WAITING`; lo que esté corriendo termina el paso y la siguiente verificación lo cancela. Ejecuciones manuales se pueden cancelar desde el detalle.
8. **Bucles**: los cambios hechos por una ejecución viajan con `causedBy`; una automatización no se redispara a sí misma y la cadena se corta en profundidad 3.
9. **Frecuencia**: `maxRunsPerHour` (1–500, defecto 60) por automatización. Lo que excede queda `CANCELLED` y visible en el historial. Es un tope suave (conteo previo): bajo carga simultánea puede pasar por pocas unidades.

**Garantía no cubierta**: los eventos se publican en proceso después de guardar el cambio; si el proceso muere justo entre ambos, ese evento se pierde (no hay outbox). Siguiente paso recomendado: colección `DomainEvent` (outbox) escrita en la misma operación.

## 5. Índices (no aplicados)
Declarados en el schema, **no** se ejecutó `db push`:
- `Automation @@index([companyId, status, triggerType])` — lookup por evento.
- `AutomationVersion @@index([companyId, automationId])`.
- `WorkflowRun @@index([companyId, automationId, createdAt])` — historial.

Sin ellos todo funciona (consultas más lentas con volumen). Procedimiento seguro: primero en la base aislada del piloto (`node scripts/pilot-env.cjs npx prisma db push --skip-generate`), revisar `listIndexes`, y en Atlas solo con aprobación y en ventana de baja carga (crear índices no borra datos; `db push` sí puede proponer cambios destructivos: revisar su salida antes de confirmar).

## 6. Inventario de procesos existentes (Bloque H)
| Proceso | Dónde | Qué hace | ¿Externo? | Estado |
|---|---|---|---|---|
| Asignación automática de domiciliario | `OrdersService.autoAssignCourier` al pasar a «listo» | asigna el domiciliario en turno con menos carga | No | **Migrable al motor** (abajo) |
| Recordatorios de pedido | `RemindersService.dispatchDue` (cada min) | WhatsApp/correo a áreas, despacho, cliente | Sí | Sin migrar |
| Encuesta post-entrega | `scheduleFeedback` | mensaje al cliente | Sí | Sin migrar |
| Avisos de reservas | `BookingsService.tick` (cada min) | WhatsApp de confirmación/recordatorio | Sí | Sin migrar |
| Reactivación | `ReactivationService.hourly` | WhatsApp a clientes dormidos | Sí | Sin migrar |
| Cobranza | `CollectionsService.hourly` | WhatsApp de cobro | Sí | Sin migrar |
| Campañas y seguimientos | `CampaignsService` (cada min / 10 min) | difusiones y seguimiento a conversaciones | Sí | Sin migrar |
| Producciones | `WorkflowService` | tareas por regla, vencidas, retenciones | No | Ya en el motor |

### Migración: asignación de domiciliarios
- **Activar**:
  1. Crear una automatización: «Un pedido cambia de estado» con `toStatus = listo`, condición «Tiene domiciliario: no» y acción «Asignar domiciliario automático».
  2. Activarla.
  3. En la tarjeta «Migración», pulsar «Pasar a la automatización». Eso guarda `orderConfig.delivery.autoAssignVia = 'automation'`.
- **Revertir**: «Volver al proceso original» (quita el campo). También se revierte solo si la automatización se pausa o archiva: `courierAssignmentOwner` devuelve `legacy` cuando no hay una activa que asigne, para que nunca queden pedidos sin domiciliario.
- **Sin duplicados**:
  - Ambos caminos llaman a la misma función, que primero verifica quién es el dueño.
  - Además, la asignación es condicional (`updateMany … courierId: null`).
  - Las pruebas verifican el mismo domiciliario elegido y una sola auditoría `delivery.auto_assign`.
- **Diferencia operativa**: con cola, el motor asigna de forma asíncrona (segundos) en vez de en la misma petición.

## 7. Permisos y aislamiento
- **Productos y roles:**
  - El producto requerido es `@Products('AUTOMATION')`.
  - Escritura, simulación, cancelación y migración: SUPER_ADMIN, DEV y COMPANY_ADMIN. Consulta: lectura e historial.
- **Empresa:**
  - La empresa sale de `requireTenant` y `tenantFilter`; el `companyId` del navegador solo cuenta para la plataforma.
  - Los recursos de otra empresa responden 404.
- **Al publicar** se valida que los responsables sean usuarios activos de la empresa y que las etapas existan en sus embudos.
- **Al ejecutar** todo se relee dentro de la empresa de la ejecución.
- `@Section('automations')` no se aplicó, por la misma razón que en la Fase 1 (empresas antiguas sin la sección en `modulesJson`).
