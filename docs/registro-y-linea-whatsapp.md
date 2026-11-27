# Registro con contacto primero, medición y línea de WhatsApp de BackOffice

## Cómo funciona el registro (`/registro`)

1. **Paso 0 · contacto primero.** Una sola pantalla: una frase, nombre del negocio y WhatsApp (+57). El correo es opcional y va debajo del botón. Se prerenderiza en `registro.html`, así que se ve apenas llega el HTML. `public/early.js` cuenta `registro_abierto` y guarda lo que la persona alcance a escribir antes de que cargue la app. Al enviarlo pasa esto, sin IA y sin esperar al servidor:
   - `POST /public/signup/contact` (con reintentos) deja el registro en «Dejó contacto», y desde ahí queda en «Por contactar».
   - Aviso a Telegram (`SIGNUP_CONTACT`) con el negocio, el WhatsApp, el paso y la fuente, más un botón wa.me.
   - Correo «Recibimos tu solicitud», si dejó correo.
   - `Lead` en el píxel (`lead-<sesión>`) y en la API de Conversiones, con el mismo `event_id`.
2. **Cinco preguntas fijas**, definidas en `apps/web/src/pages/public/signup/questions.ts`. Se responden tocando, con «Otro» y texto libre donde hace falta. Después de la 2 aparece un adelanto armado por código.
3. **Una sola llamada de IA:** `POST /public/signup/preview` con las respuestas en forma de conversación. Si la persona pegó una web, el servidor lee su título y descripción (`common/site-peek.ts`, con protección contra direcciones internas).
4. Propuesta, productos y cuenta: igual que antes. Al crear la empresa se manda `CompleteRegistration` (`reg-<sesión>`).

**Retomar.** Si una persona deja correo y pasa 30 minutos sin actividad, el cron de cada 15 minutos le manda «Te quedaste en la pregunta X» una sola vez. El enlace `/registro?retomar=<token firmado, 72 h>` retoma con la misma sesión.

**Contacto rápido.** «Que me escriban hoy» y «Agendar una videollamada de 15 min» usan los mismos horarios que Citas (`GET /public/signup/slots`, `POST /public/signup/quick-contact`).

## Medición

- **Eventos** (`SignupEvent`), uno por tipo y pregunta por sesión: `registro_abierto`, `presentacion_vista`, `formulario_visto`, `formulario_empezado`, `contacto_enviado`, `contacto_dejado`, `pregunta_vista`/`pregunta_respondida` (1 a 5), `adelanto_visto`, `plan_revisado`, `datos_llenados` y `empresa_creada`.
- **Fuente:** se captura en cualquier página de la web (`lib/origin.ts`, 30 días en el navegador) y el servidor guarda el primer toque de cada registro. Incluye `utm_*`, `g` (grupos por ciudad), `fbclid` y el referrer externo.
- **Panel Plataforma → Registros:**
  - Embudo con «Dejó contacto».
  - Embudo detallado: la pantalla de entrada, cada pregunta (la vieron, la respondieron, % de abandono y tiempo promedio) y lo que sigue.
  - Filtro y desglose por fuente.
  - Tiempo hasta el primer contacto: se registra al marcar «Contactado» o al tocar WhatsApp. La meta es menos de 5 minutos en horario laboral.
- **Regla de abandono, sin cambios:** 30 minutos sin actividad. Ahora el panel además dice en qué pregunta se fue.

## Variables de entorno nuevas

| Variable | Dónde | Para qué | Si falta |
|---|---|---|---|
| `VITE_META_PIXEL_ID` | Vercel | Píxel de Meta en la web pública (se carga después de la página) | No hay píxel |
| `VITE_PUBLIC_WHATSAPP` | Vercel | Número del botón flotante de WhatsApp (con indicativo) | No hay botón |
| `META_CAPI_PIXEL_ID` | Render | Conjunto de datos de la API de Conversiones | No se mandan eventos |
| `META_CAPI_TOKEN` | Render | Token de la API de Conversiones (Administrador de eventos) | No se mandan eventos |
| `META_CAPI_TEST_CODE` | Render (opcional) | Código de «Probar eventos» mientras se verifica | — |

Las variables `VITE_` se leen al compilar: después de cambiarlas en Vercel hay que volver a desplegar.

## Para activar el píxel y la API de Conversiones

1. En el Administrador de eventos, usar el conjunto de datos de BackOffice (o crear uno) y copiar su ID.
2. Cargar `VITE_META_PIXEL_ID` en Vercel y `META_CAPI_PIXEL_ID` en Render con ese mismo ID.
3. En Configuración → API de Conversiones → «Generar token de acceso», cargarlo en Render como `META_CAPI_TOKEN`.
4. Para verificar: cargar `META_CAPI_TEST_CODE` con el código de «Probar eventos», hacer un registro de prueba y confirmar que `Lead` llega del navegador y del servidor como un solo evento (deduplicado). Después borrar `META_CAPI_TEST_CODE`.
5. En la campaña, optimizar por `Lead` (dejó contacto) o `CompleteRegistration`. Con el público «visitó /registro y no generó Lead» se arma el retargeting.

## Línea de WhatsApp de BackOffice (preparada, NO activada)

- Mientras la línea no esté conectada a la plataforma, el botón flotante y el aviso de Telegram abren wa.me hacia el número de `VITE_PUBLIC_WHATSAPP`, que se atiende desde la app WhatsApp Business.
- **Coexistencia** (el mismo número en la app WhatsApp Business y en la API): el alta actual de la plataforma (`apps/web/src/components/whatsapp/meta.tsx`) abre el registro integrado de Meta con `featureType: ''`. Ese es el modo normal, que no soporta coexistencia. Para soportarla falta:
  1. Abrir el registro integrado con `featureType: 'whatsapp_business_app_onboarding'`, como una opción aparte del alta normal.
  2. Que la configuración de Facebook Login for Business (`config_id`) tenga el permiso de la app de WhatsApp Business.
  3. Que el número use una versión reciente de WhatsApp Business y esté en un país donde Meta habilita la coexistencia.
  4. Sincronizar los contactos y el historial que Meta comparte, y manejar los mensajes que se envían desde la app (webhooks `smb_message_echoes`).
- Para que el bot de BackOffice atienda a los interesados: crear la empresa «BackOffice» en la plataforma, conectar la línea por el alta de arriba y configurar su asistente con las preguntas del registro. Hoy no se hace nada de esto automáticamente.
