# Reunión con LPulpo: lista de decisiones

Estados: **Pendiente** = falta la respuesta de LPulpo · **Confirmado** = hay evidencia · **No aplica**.
Nada de esto está confirmado todavía: no hay respuestas del cliente registradas.

## Operación

| Tema | Estado | Qué preguntar | Dónde se configura |
|---|---|---|---|
| Servicios y tipos de producción | Pendiente | ¿Qué servicios ofrecen? Hoy están cargados: modelos, locación, fotografía, dirección creativa, styling, asistentes, alimentación y otros. ¿Faltan o sobran? | Configuración del flujo → Servicios y brief |
| Campos obligatorios del brief | Pendiente | Hay una sugerencia inicial: descripción, fechas, duración y número de modelos; para cotizar, además los entregables. ¿Cuáles son de verdad? | Servicios y brief |
| Usuarios, bookers y permisos | Pendiente | ¿Quiénes son los 3 a 5 bookers? ¿Quién aprueba cotizaciones? ¿Quién ve costos y márgenes? | Equipo y Usuarios y permisos |
| Proceso de aprobación de cotizaciones | Pendiente | ¿Aprueba siempre el booker? ¿Hay montos que requieran a otra persona? | Parámetros comerciales → Aprobaciones |
| Reglas de disponibilidad y retenciones | Pendiente | ¿Cuánto dura una retención de un modelo o de la locación? ¿Qué pasa al vencer? | Parámetros comerciales → Duración de retenciones |
| Tareas automáticas | Pendiente | ¿Las tareas de ejemplo (brief, disponibilidad, precios, cotización, aprobación, confirmación, logística, entregables, cierre) sirven? | Tareas automáticas |
| Qué automatiza el sistema y qué aprueba una persona | Pendiente | Hoy el sistema solo crea tareas, marca vencidas y libera retenciones vencidas. Enviar, confirmar o cancelar es siempre humano. ¿Están de acuerdo? | — |

## Comercial

| Tema | Estado | Qué preguntar |
|---|---|---|
| Comisión del 30 % | Pendiente | ¿Sobre qué base: precio al cliente o costo del proveedor? ¿A qué servicios aplica? ¿Hay excepciones? |
| Márgenes por servicio | Pendiente | ¿Margen fijo por tipo de servicio o negociado en cada caso? |
| Tarifas, jornadas y costos adicionales | Pendiente | ¿Hay tarifas de referencia por modelo o fotógrafo? ¿Cuáles son las unidades: hora, media jornada, jornada? ¿Hay recargos (horas extra, transporte)? |
| Gastos que cubre el cliente | Pendiente | ¿Alimentación, vestuario y otros los paga el cliente directamente o se facturan? |
| Impuestos y retenciones | Pendiente | ¿Cómo se muestran en la cotización? |
| Cancelaciones y anticipos | Pendiente | ¿Hay política de cancelación? ¿Hay anticipo, y de cuánto? |
| Lead calificado, venta y conversión | Pendiente | ¿Cuándo un contacto es lead calificado? ¿Cuándo cuenta como venta: cotización aceptada, producción realizada o pago recibido? |
| Indicadores y línea base | Pendiente | ¿Cuánto tardan hoy en responder y en cotizar? Para comparar haría falta registrar dos semanas. |

## Integraciones y accesos

| Tema | Estado | Qué hace falta |
|---|---|---|
| WhatsApp | Pendiente | ¿Qué número usan? ¿Está en la app WhatsApp Business (la coexistencia o la migración se revisan antes de tocarlo)? ¿Proveedor (Cloud API de Meta o Twilio)? ¿Quién administra el Business Manager? Costos de Meta para Colombia: por verificar |
| Meta Ads | Pendiente | Acceso de solo lectura a la cuenta publicitaria (token `ads_read` de un administrador). ¿Qué campaña corresponde a qué servicio? ¿Usan formularios instantáneos? |
| Instagram y Facebook | Pendiente | Página y cuenta conectadas al Business Manager; permisos de mensajería (revisión de la app) |
| Google Calendar | Pendiente | ¿Qué calendario usan para la locación propia? Hace falta el cliente OAuth de BackOffice (pendiente) |
| Dropbox | Pendiente | ¿Cuenta personal o de equipo? ¿Qué carpetas entran? ¿Cómo quieren organizar las fichas de modelos? La integración no está construida; por ahora las rutas se registran a mano |

## Datos personales y consentimiento

| Tema | Estado | Qué preguntar |
|---|---|---|
| Contactar modelos desde el sistema | Pendiente | ¿Los modelos aceptan recibir mensajes de BackOffice? ¿Cómo se registra ese consentimiento? |
| Uso de fotos | Pendiente | ¿Quién puede ver las fotos de los modelos? ¿Qué derechos de uso tienen? ¿Hay menores de edad? |
| Datos de clientes | Pendiente | ¿Qué datos del cliente guardan (NIT, razón social, contacto)? |

## Qué se puede mostrar en la reunión

En el entorno local del piloto (ver `SETUP_GUIDE.md`), con registros marcados como prueba:

- Crear una solicitud desde cero (canal, contacto, booker).
- Ver qué falta en el brief y completarlo.
- Agregar modelos y la locación; registrar disponibilidad (manual) y retener con vencimiento.
- Armar una cotización con valores pendientes y ver por qué no se puede aprobar; aprobarla con el perfil correcto y ver la versión 2 con sus cambios.
- Ver las tareas que crea el motor, el historial y una incidencia.
- Ver el estado real de cada integración.

**No se puede mostrar** porque requiere accesos o desarrollo:
- Mensajes reales por WhatsApp o Instagram.
- Datos reales de Meta Ads.
- Sincronización con Google Calendar.
- Dropbox.
- Envío de cotizaciones.
