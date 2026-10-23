# Google Calendar ↔ BackOffice (Fase 2A.1)

Estado al 23-oct-2026: implementado en local y sin desplegar. Está probado contra un Google falso que sigue el contrato de la API oficial.

**No se ha probado con una cuenta real de Google.** Falta el cliente OAuth de la plataforma (ver «Configuración externa»). Hasta esa prueba de punta a punta, la integración se considera **lista para verificar, no terminada**.

## Piezas

| Archivo | Qué hace |
|---|---|
| `apps/api/src/common/google-calendar.ts` | Cliente REST mínimo de Calendar v3 y OAuth 2.0, sin dependencias. Clasifica errores (AUTH, GONE, NOT_FOUND, PRECONDITION, RATE, SERVER, NETWORK). |
| `apps/api/src/modules/calendar-sync.module.ts` | `CalendarSyncService`: conexión, envío, lectura, conflictos, canales y recuperación. También los controladores. |
| `apps/api/src/modules/bookings.module.ts` | Avisa cada cambio de una reserva (`onAppointmentChange`). Considera lo ocupado en Google en la disponibilidad y al reservar o reprogramar. |
| `apps/api/prisma/schema.prisma` | `CalendarConnection` (una por empresa) y `CalendarEventLink` (vínculo evento ↔ reserva, o bloqueo externo). |
| `apps/web/src/pages/company/integrations/GoogleCalendar.tsx` | Tarjeta en Integraciones. |
| `apps/web/src/pages/company/Agenda.tsx` | Muestra los bloques de Google, el estado de cada reserva y el aviso de conflictos. |
| `apps/api/test/google-calendar.spec.ts` | 33 pruebas de la API. |
| `apps/api/test/helpers/fake-google.ts` | El Google falso que usan esas pruebas. |
| `apps/web/.../GoogleCalendar.test.tsx` | 6 pruebas de la tarjeta. |

### Endpoints

Todos exigen Automation. Los de escritura piden rol de escritura. El `companyId` sale de la sesión; solo plataforma puede indicar otro.

- `GET /calendar/google`: estado, sin tokens.
- `GET /calendar/google/overlay`: bloques y estado por reserva para la agenda.
- `POST /calendar/google/connect`: devuelve la URL de Google.
- `POST /calendar/google/calendar`: elige el calendario.
- `PUT /calendar/google/settings`: guarda los ajustes.
- `POST /calendar/google/sync`: sincroniza a mano (máximo 6 por minuto).
- `POST /calendar/google/conflicts/:id/resolve`: resuelve un conflicto.
- `DELETE /calendar/google?deleteCreatedEvents=1`: desconecta.
- Públicos:
  - `GET /public/calendar/google/callback`: vuelta de OAuth, con estado firmado.
  - `POST /public/calendar/google/notify`: avisos de Google. Valida el canal, el token (guardado como hash) y el resourceId.

## Conexión y seguridad

- **OAuth propio de cada empresa**, con `access_type=offline` y `prompt=consent`.
- **Permisos mínimos:**
  - `calendar.calendarlist.readonly`: elegir el calendario.
  - `calendar.events`: leer y escribir eventos del calendario elegido.
  - Si la persona desmarca alguno, la conexión no se crea (`?google=permisos`).
- **Tokens:**
  - Se guardan cifrados con `MASTER_ENCRYPTION_KEY`.
  - Nunca salen por la API ni a los logs.
  - El access token se cachea cifrado y se renueva solo.
- **Estado de OAuth:** el `state` va firmado, dura 15 minutos y amarra empresa y usuario.
- **Calendarios permitidos:** solo los de la cuenta con permiso de escritura.
- **Desconectar:**
  - Detiene el canal y revoca el acceso en Google.
  - Borra los vínculos y la conexión.
  - Opcionalmente borra los eventos que BackOffice creó, y nunca otros.
  - Las reservas no cambian.
- **Auditoría:** conectar, elegir calendario, ajustes, sincronización manual, conflictos y desconexión.

## Sincronización

### BackOffice → Google

Se activa con cada cambio de reserva y también al sincronizar.

- **Id del evento:** determinista, `bo` + hex(id de la reserva). Lleva `extendedProperties.private` con los ids de la reserva y de la empresa.
- **Contenido del evento:**
  - Servicio, espacio y «· BackOffice».
  - La descripción solo tiene el código de la reserva. No lleva nombre, teléfono ni otros datos del cliente.
  - La hora va en la zona del negocio.
- **Idempotencia:** se guarda un hash de lo enviado; si no cambió, no se llama a Google.
- **Crear:** es CREATE mientras Google no lo haya confirmado (sin etag). Si Google lo creó pero la respuesta se perdió, el reintento recibe 409 y se actualiza: no hay duplicados.
- **Cambiar:** PATCH con `If-Match` (etag). Si en Google lo cambiaron entretanto, responde 412 y queda un **conflicto**; no se pisa.
- **Cancelar o borrar la reserva:** se borra el evento.
- **Fallos:**
  - 5xx, 429 o red: reintento con espera creciente (2, 4, 8… hasta 60 min), máximo 8 intentos. El error se ve en la tarjeta.
  - Credencial revocada: la conexión queda `REVOKED` («reconecta»).
  - En ningún caso se toca la reserva ni su historial.

### Google → BackOffice

Se activa con los avisos (push), cada 15 minutos (recuperación) o a mano.

- **Lectura:**
  - La primera es completa, desde 24 h atrás.
  - Después es incremental con `syncToken`.
  - Si Google responde 410, se relee todo y se rehacen los bloqueos, sin duplicar.
- **Eventos de BackOffice:**
  - Vuelven con el mismo etag y **se ignoran**; así no hay ciclos.
  - Si cambian de hora en Google: conflicto `EDITED_IN_GOOGLE`. No se aplica solo.
  - Si los borran en Google: conflicto `DELETED_IN_GOOGLE`.
- **Eventos ajenos:** se guardan como **bloqueo** (inicio y fin).
  - Sin título, salvo que la empresa active «mostrar títulos». Al apagarlo se borran los guardados.
  - Ocupan si son opacos, no rechazados por el dueño y, si son de todo el día, solo cuando «todo el día bloquea» está activo (por defecto sí).
  - Los «Disponible» (transparentes) y los rechazados no ocupan.
- **Espacios bloqueados:** la empresa elige cuáles bloquea Google. Si no elige ninguno, son todos.
- **Choques:** si un evento ajeno se cruza con una reserva ya confirmada, queda el conflicto `OVERLAPS_BOOKING`.
  - **La reserva nunca se cancela sola.**
  - Se puede descartar; vuelve a avisar si el evento cambia.
- **Concurrencia:** una sola sincronización por empresa a la vez. Dentro del proceso hay un candado; entre servidores, un lease en la base de 5 minutos.

### Notificaciones

- **Canal:** `events.watch` con TTL de 7 días. Se renueva 24 h antes de vencer; primero se crea el nuevo y luego se detiene el viejo.
- **URL pública:** requiere `WEBHOOK_BASE_URL` con https. Sin ella no hay avisos y se sincroniza cada 15 minutos, y la tarjeta lo dice.
- **Validación:** un aviso con token o canal falsos se ignora. El aviso inicial `sync` solo se confirma.

## Reglas de negocio

- **Sin dobles reservas:** el candado de BackOffice (`BookingLock`) sigue siendo la garantía. Google solo **suma** bloqueos; nunca reemplaza la validación.
- **Revalidación:** al reservar o reprogramar se vuelve a revisar lo ocupado en Google. Si todos los espacios están ocupados allá, se responde «Ese horario está ocupado en el calendario del negocio.».
- **Sin dependencia de Google:** si Google falla o está desconectado, reservar sigue funcionando con lo último sincronizado.
- **Eventos que BackOffice no creó:** nunca los cambia ni los borra.
- **Conflictos:** los resuelve una persona.
  - Mantener BackOffice.
  - Usar la hora de Google: reprograma con las mismas validaciones y avisa al cliente.
  - Volver a poner el evento en Google.
  - Cancelar la reserva.
  - Descartar un choque.

## Zonas horarias

- **Instantes:** todo se guarda en UTC.
- **Eventos con hora:** se leen con su offset.
- **Eventos de todo el día:** se ubican en la zona del evento o del calendario. Un día con cambio de horario dura 23 o 25 h (probado con Nueva York, 1-nov-2026).
- **Reservas:** van con la zona del negocio. Si Google las devuelve escritas en otra zona pero en el mismo instante, no es un cambio.

## Configuración externa pendiente

1. **Proyecto de Google Cloud:** activar **Google Calendar API**.
2. **Pantalla de consentimiento OAuth (externa):**
   - Nombre, logo, dominio, política de privacidad y términos.
   - Los dos permisos de arriba.
3. **Credenciales → ID de cliente OAuth (aplicación web):**
   - URI de redirección autorizada: `<PUBLIC_WEB_URL>/api/public/calendar/google/callback`.
   - Es la misma ruta que la API sirve bajo `/api`; si la web y la API van por dominios distintos, debe apuntar a donde responda la API.
4. **Credenciales en BackOffice:** guardar `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en Dev Tools → Google Calendar o como variables de entorno. Nunca en el repositorio.
5. **Avisos:** `WEBHOOK_BASE_URL` con https público, y verificar el dominio en Search Console si Google lo pide.
6. **Verificación de Google:** `calendar.events` es un permiso **sensible**.
   - Mientras la app esté «en prueba», solo funcionan hasta 100 usuarios de prueba agregados a mano.
   - Los refresh tokens vencen a los 7 días.
   - Para clientes reales hay que pedir la verificación (revisión del uso de datos y video del flujo).
7. **Base de datos:** `prisma db push` en producción, para las colecciones `CalendarConnection` y `CalendarEventLink` y sus índices.
8. **Prueba de punta a punta con una cuenta real:**
   - Conectar.
   - Elegir calendario.
   - Crear, reprogramar y cancelar una reserva y verla en Google.
   - Crear, mover y borrar un evento en Google y verlo bloquear.
   - Editar en ambos lados para ver el conflicto.
   - Desconectar.

## Limitaciones conocidas

- **Un calendario por empresa;** no hay uno por espacio. La empresa elige qué espacios bloquea.
- **Recurrentes:** se leen expandidos (`singleEvents`). La ventana completa inicial empieza 24 h atrás; lo anterior no se importa.
- **Reservas sin espacio** (citas manuales antiguas): no se envían a Google.
- **Proveedores:** no hay Outlook ni Calendly.
- **Recuperación:** el cron corre cada 15 minutos en cada instancia, protegido por el lease. Localmente se apaga con `CALENDAR_CRON_DISABLED=1`.
- **Integraciones genéricas viejas:** las de tipo `GOOGLE_CALENDAR` (sin conexión real) ya no se muestran ni se pueden agregar. La tarjeta real las reemplaza.
