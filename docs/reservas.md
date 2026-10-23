# Reservas reales por el chat (Fase 2)

Estado al 23-oct-2026, en local y sin desplegar. Código:
- Lógica pura: `apps/api/src/common/bookings.ts`.
- Servicio y endpoints: `apps/api/src/modules/bookings.module.ts`.
- Herramientas del agente: `apps/api/src/ai/agent/tools.ts` (`BOOKING_TOOLS`).
- Panel: `apps/web/src/pages/company/agenda/Bookings.tsx`.

## Qué hace

- **Disponibilidad real:** salen solo los turnos que cumplen todo esto:
  - el horario de reservas (o el horario general del negocio);
  - los festivos y días no laborales;
  - la anticipación mínima;
  - el rango máximo de días;
  - la duración del servicio;
  - los espacios donde se presta;
  - lo ya ocupado.

  Sirve para cualquier cosa reservable por tramos: canchas, salas, consultorios, turnos.
- **Reserva por el chat**:
  - **Herramientas:** `ver_disponibilidad` (lectura), `crear_reserva`, `mis_reservas`, `cancelar_reserva` y `reprogramar_reserva`.
  - **Confirmación:** crear, cancelar y reprogramar exigen `cliente_confirmo: true`. Si falta, la herramienta se niega y le pide al agente mostrar el resumen.
  - **Nombre:** se pide si el contacto solo tiene su número.
  - **Validación:** todo lo valida el servidor justo antes de reservar.
  - **Prompt:** las reglas de reserva (nunca decir "reservado" sin `ok`, ofrecer las alternativas que devuelve la herramienta, pasar a una persona si es ambiguo) se agregan solo si el bot tiene esas herramientas.
- **Contra reservas dobles**, aunque lleguen pedidos simultáneos:
  1. Cada tramo de un recurso es un `BookingLock` con índice único (empresa, recurso, inicio del tramo).
  2. **Defensa en el código, aunque falte el índice:** tras tomar el tramo se verifica, y si hay dos gana el más antiguo con la misma regla en ambos pedidos.
  3. Los tramos se toman **antes** de crear la reserva. Reprogramar toma los nuevos antes de soltar los viejos.
  4. Un bloqueo huérfano (proceso caído a mitad) se libera a los 2 minutos.
  5. La misma conversación pidiendo lo mismo dos veces no duplica (`idempotencyKey`).
- **Identidad y permisos:**
  - El cliente es el contacto de la conversación, identificado por su número. Solo consulta, cancela o reprograma **sus** reservas.
  - La empresa sale de la sesión o de la conversación, nunca del navegador ni de la IA.
  - Endpoints con `@Products('AUTOMATION')` y roles de escritura.
  - Las herramientas de reserva solo vienen en el preset `reservas`. Restaurantes y "solo consultas" no las reciben.
  - Un negocio nuevo con agenda y sin pedidos recibe ese preset.
- **Derivar a una persona:**
  - El servicio lo indica en estos casos: tope de reservas por cliente; cancelar o reprogramar con menos de N horas; servicio que ya no existe; reservas apagadas.
  - Si es ambiguo o no hay turno que le sirva, el prompt indica `pasar_a_humano`.
- **Registro:**
  - `Appointment.source` (IA o MANUAL), `historyJson` (creada, reprogramada, cancelada, aviso fallido; con quién y cuándo) y la auditoría.
  - Desde el panel se ven el código, el historial y el estado de cada aviso.
- **Panel** (Agenda):
  - Pestaña "Reservas en línea": espacios, servicios, horario, reglas y avisos.
  - "+ Reserva": por teléfono o con un contacto existente, eligiendo entre los turnos reales.
  - "Reprogramar o cancelar" en cada reserva.
  - La agenda clásica no puede mover la hora de una reserva por fuera de los bloqueos; cancelarla o borrarla los libera.

## Avisos al cliente (confirmación, recordatorio, cambio, cancelación)

- **Modelo:** `BookingNotice`, aparte de los recordatorios de pedidos (no se mezcla con ese cron). Es único por reserva + tipo + momento.
- **Envío:** cron cada minuto (apagable con `BOOKINGS_CRON_DISABLED=1`).
  - Usa la **cola de salida ya integrada** (`WA_OUTBOUND_QUEUE` → Twilio o Meta Cloud API, según la línea), como categoría UTILIDAD.
  - Los reintentos del proveedor los hace esa cola: 5 intentos con espera creciente, y el estado de entrega queda en el mensaje.
- **Si encolar falla** (por ejemplo, Redis caído):
  - Se reintenta con espera creciente sin duplicar el mensaje.
  - Al quinto intento queda FAILED y se anota en el historial.
- **No se envía, y queda el motivo, si:**
  - el cliente pidió no recibir mensajes;
  - la empresa no tiene Automation;
  - los recordatorios están apagados;
  - la reserva se canceló;
  - no hay chat con el cliente;
  - está fuera de la ventana de 24 h de Meta sin la plantilla aprobada `recordatorio_reserva`. En Instagram y Messenger no hay plantilla posible.

## Pendiente o limitado (sin simular)

- **`prisma db push` en producción** para crear los índices (`BookingLock` único, `BookingNotice` único y los de `Appointment`). La defensa en código protege igual, pero el índice es la garantía principal.
- **Plantilla `recordatorio_reserva`:** hay que crearla en Meta/Twilio y cargarla en las plantillas de la empresa para avisar fuera de las 24 h.
- **Sin Google Calendar** ni otro calendario externo: no está integrado.
- **Sin cobro de anticipos de reservas.** El link de pago existe solo para pedidos.
- **Bots ya creados:** las herramientas de reserva se activan en su configuración (Asistentes IA → herramientas). El preset se aplica solo a bots nuevos.
- **Citas manuales sin espacio** (las anteriores) no bloquean turnos de los espacios.
