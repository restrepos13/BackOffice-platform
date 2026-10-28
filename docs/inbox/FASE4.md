# Omnichannel Inbox · Fase 4

Documento operativo, sin secretos.

## 1. Estado de las integraciones

| Canal | Recepción | Envío | Estados de entrega | Verificado con |
| --- | --- | --- | --- | --- |
| WhatsApp por Twilio | Webhook firmado, deduplicado | Texto; plantillas por `contentSid` fuera de la ventana | Status callback de Twilio, en orden | **Solo mocks.** No hay credenciales reales en el entorno revisado. |
| WhatsApp por Meta Cloud API | Webhook firmado, deduplicado | Solo texto dentro de 24 h. **Las plantillas por Meta aún no existen** en BackOffice. | **Nuevo:** `statuses` (sent, delivered, read, failed), en orden | **Solo mocks** |
| Instagram / Messenger | Webhook firmado, deduplicado | Texto dentro de 24 h. Fuera de la ventana, nada (`HUMAN_AGENT` no está implementado). | No se procesan (Meta los manda como `message_deliveries` / `message_reads`). | **Solo mocks** |

**Estado verificable de cada canal** (`GET /conversations/channels`). El estado ya no se toma del campo `status` que alguien marcó a mano, sino de lo que se puede comprobar:
- No configurado.
- Modo prueba.
- Pendiente de verificación.
- Conectado y verificado.
- Credenciales vencidas o sin permiso.
- Error de conexión.

«Verificar» hace una consulta **de solo lectura**: Twilio lee los datos de la cuenta y Meta lee el número o la página. Nunca envía mensajes. Si un envío falla por credenciales (401/403), el canal pasa solo a «credenciales vencidas».

## 2. Lo que se implementó

**Bandeja** (`GET /conversations/inbox`)
- Cursor estable (última actividad + id), 30 por página y un máximo de 100.
- Filtros: estado (validado), canal, línea, modo (IA o persona), responsable (mías, sin responsable o una persona), no leídas, con atención y fechas.
- Búsqueda por nombre, teléfono, correo, identificador del canal o contenido.
- Contadores reales de la empresa: no leídas, mías abiertas, sin responsable y con atención.
- `GET /conversations` se conserva igual, por compatibilidad.

**Historial** (`GET /conversations/:id/messages`): páginas de 50 con «Cargar anteriores». El detalle acepta `?messages=none`.

**Asignación por conversación** (`PATCH /conversations/:id/assign`). Se eligió por conversación, y no por contacto, porque un contacto puede tener varias conversaciones (por líneas distintas) con responsables distintos. El responsable del contacto sigue visible en la ficha.
- Solo a miembros **activos** de la **misma empresa** con rol `COMPANY_ADMIN`, el único rol que hoy puede responder.
- Se puede quitar.
- Queda en la auditoría como «antes → después» y avisa en vivo.

**Notas internas** (`GET/POST /conversations/:id/notes`), en el modelo `ConversationNote`:
- Guardan autor y fecha, y admiten hasta 2.000 caracteres.
- Se cargan en páginas de 50.
- Nunca crean un `Message` ni pasan por la cola de salida.
- El evento en vivo lleva solo el id de la conversación, nunca el texto.

**Envío y ciclo de vida** (`TwilioService.processOutbound`, para Twilio y Meta)

| Estado | Significado |
| --- | --- |
| `QUEUED` | En cola |
| `SENDING` | Se reclamó con compare-and-set: dos workers no envían el mismo mensaje |
| `SENT` | El proveedor lo aceptó, con su ID |
| `DELIVERED` / `READ` | Llegaron por webhook, sin retroceder |
| `FAILED` | Rechazo del proveedor, con `deliveryError` limpio de tokens |
| `UNCERTAIN` | **Sin respuesta clara:** pudo haber salido |
| `SIMULATED` | Modo prueba o sin credenciales. Antes quedaba como `SENT` |
| `CANCELLED` | Respuesta del bot retirada porque una persona tomó la conversación |

**Cómo se decide qué hacer con un error**
- **429**: vuelve a la cola y BullMQ reintenta con espera. Es seguro, porque el proveedor lo rechazó sin procesarlo.
- **Otros 4xx**: `FAILED` y no se reintenta.
- **Red caída, timeout, 5xx o respuesta sin ID**: `UNCERTAIN`. **No se reenvía solo.** El reenvío manual (`POST …/messages/:id/resend`) exige confirmar el riesgo de duplicado.
- Un `SENDING` viejo (más de 2 min) se marca `UNCERTAIN`.
- Al agotarse los reintentos: si estaba `QUEUED` queda `FAILED`; si estaba `SENDING`, `UNCERTAIN`.
- Meta ya no inventa un ID (`meta_<fecha>`) cuando no lo devuelve: el resultado queda incierto.

**Recepción idempotente.** Un recibo `InboundReceipt` con `_id` derivado de canal + ID del proveedor se reclama **antes** de procesar. Así, dos webhooks iguales, aunque lleguen a la vez y sin índices únicos, crean un solo mensaje y disparan el bot una sola vez. Si el procesamiento falla a mitad, el recibo se suelta para que el reintento del proveedor sí entre.

**Ventana de 24 h y plantillas** (`GET /conversations/:id/window`, `common/inbox/window.ts`). El servidor valida **antes** de crear el mensaje:

| Situación | Se permite |
| --- | --- |
| Dentro de la ventana | Texto libre |
| WhatsApp por Twilio, fuera de la ventana | Solo una plantilla registrada (`waTemplatesJson`, con su `contentSid`), con el número exacto de variables |
| WhatsApp por Meta, fuera de la ventana | Nada, con el motivo: plantillas por Cloud API no implementadas |
| Instagram / Messenger, fuera de la ventana | Nada, con el motivo |
| Sin línea | Nada |

BackOffice **no consulta la aprobación** de la plantilla a Meta: si no está aprobada, Twilio la rechaza y el mensaje queda `FAILED` con el motivo.

**Modo humano y bot**
- `setMode` y escribir a mano registran `modeChangedAt` y `modeChangedBy` (además de la auditoría que ya existía) y retiran las respuestas del bot en cola.
- El motor toma un candado por conversación con compare-and-set y vencimiento de 2 min: dos procesos no responden al mismo mensaje.
- Si un agente toma la conversación mientras el modelo piensa, la respuesta se descarta (`bot.reply_discarded`).
- Si llega un mensaje del cliente mientras se responde, se atiende al terminar, en una corrida más, para que no se pierda.
- El motor de automatizaciones de la fase 2 no cambia: la bandeja no tiene reglas propias.

**Tiempo real**
- El cliente SSE informa el estado (en vivo o reconectando) y, al reconectar, recarga la lista y la conversación abierta, porque SSE no reenvía lo perdido.
- La búsqueda espera 300 ms antes de consultar.

**Otros cambios**
- El estado de la conversación solo acepta `OPEN`, `PENDING`, `HANDOFF` o `RESOLVED`, y su cambio queda auditado.
- Una conversación resuelta no recibe mensajes hasta reabrirla.
- La versión de Graph para mensajería es configurable (`META_GRAPH_VERSION`, por defecto `v24.0`); antes era `v21.0` fija.

## 3. Modelos e índices

**Modelos.** Solo se agregaron campos opcionales y dos modelos nuevos; no hay migraciones destructivas. Se corrió `prisma generate` pero **no** `db push`.
- `Conversation`: `assignedToId`, `assignedAt`, `assignedById`, `modeChangedAt`, `modeChangedBy`, `engineLockUntil`.
- `Message`: `deliveryError`, `sendStartedAt`, `templateKey`.
- Modelos nuevos: `ConversationNote` e `InboundReceipt`.

**Índices declarados, pendientes de `db push`** (en el piloto primero; no son únicos, así que no fallan por duplicados):
- `Conversation(companyId, assignedToId, lastMessageAt)`.
- `Conversation(companyId, channel, lastMessageAt)`.
- `ConversationNote(conversationId, createdAt)`.

La idempotencia no depende de ellos: usa `_id` derivados y compare-and-set.

## 4. Riesgos para la auditoría general (no se tocaron en esta fase)

- **El JWT viaja en la URL del SSE** (`?token=`). Puede quedar en logs de proxies.
- **El SSE es un EventEmitter en memoria.** Con varias instancias del API, un evento solo llega a quienes están conectados a esa misma instancia. Hace falta Redis pub/sub antes de escalar horizontalmente.
- **El candado del motor protege entre procesos**, pero el agrupador en memoria (`pending`, cuando no hay cola) es por proceso.
- **Contactos duplicados por concurrencia.** Si dos mensajes *distintos* del mismo contacto nuevo llegan a la vez, podrían crearse dos contactos. Mongo no tiene un índice único por `companyId + phone`.
- **Mensajes entrantes fuera de orden.** Se ordenan por fecha de recepción, no por la marca de tiempo del proveedor.
- **Estado de Instagram y Messenger.** Las confirmaciones de entrega y lectura no se procesan.
- **Respuestas rápidas.** Cualquier `COMPANY_ADMIN` puede borrar las de otros de su empresa, como antes.

## 5. Pruebas

- `apps/api/test/inbox.spec.ts`: 27 pruebas.
- `apps/api/test/agent.spec.ts`: 3 pruebas nuevas del motor (respuesta tardía descartada, candado y mensaje concurrente).
- `apps/web/src/pages/company/Inbox.test.tsx`: 5 pruebas.

Todas usan proveedores simulados. **Ninguna envía mensajes reales.**

## 6. Prueba manual (en un entorno aislado, nunca contra Atlas compartido)

1. Levantar la API con `BOOKINGS_CRON_DISABLED=1` y las líneas en sandbox. Abrir *Conversaciones*.
2. Ver la tira de canales:
   - una línea sin credenciales dice «No configurado»;
   - una en sandbox, «Modo prueba».
3. Simular un mensaje entrante con el simulador del bot o con un webhook firmado de prueba. Debe aparecer en vivo, con contador de no leídas.
4. Asignar la conversación y revisar *Auditoría*. Filtrar por «Asignadas a mí».
5. Escribir una nota interna: aparece punteada y amarilla, y no hay mensaje saliente.
6. Responder:
   - en sandbox el mensaje queda «Modo prueba: no salió»;
   - con el bot activo, escribir a mano lo pausa y retira sus respuestas en cola.
7. Poner la fecha del último mensaje del cliente a más de 24 h, en la copia aislada: el compositor se bloquea y ofrece la plantilla (Twilio) o explica por qué no se puede.

## 7. Variables y permisos externos que faltan (sin valores)

| Proveedor | Qué falta |
| --- | --- |
| Twilio | `accountSid`, auth token y número por línea (se guardan cifrados en la integración), webhook y status callback apuntando a `/api/webhooks/<slug>/twilio[/status]`, y plantillas aprobadas registradas en `waTemplatesJson` |
| Meta | `META_APP_SECRET` (firma de webhooks), `META_VERIFY_TOKEN`, `META_GRAPH_VERSION` (opcional) y, por línea, el token y el `phoneNumberId`, `pageId` o `igUserId` |
| Meta, permisos | `whatsapp_business_messaging`, `pages_messaging`, `instagram_manage_messages` y la suscripción a `messages` y `message_status` (WhatsApp) |
| Meta, para escribir fuera de 24 h en Instagram/Messenger | Permiso de la etiqueta `HUMAN_AGENT` (no implementado) |
