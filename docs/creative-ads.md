# BackOffice Creative · Publicidad y Radar comercial

Documento operativo. Sin secretos: los valores reales viven solo en el `.env` de cada entorno.

> **Fase 3 (27-oct-2026):** sincronización con candado y tramos, idempotencia sin índices, métricas por objetivo, alcance y frecuencia reales, nuevos hallazgos, estados de atribución, Meta Lead Ads y ciclo de acciones. Ver [ads-intelligence/FASE3.md](ads-intelligence/FASE3.md).

## 1. Arquitectura

```
Creative (web)                    API (NestJS)                              Datos (Mongo · Prisma)
─────────────────                 ─────────────────────────────────         ─────────────────────────
Inicio (Radar + intenciones)  ─►  opportunities.module   ─┬─► common/opportunities/*  Opportunity, CompanyContext
Oportunidades                      (CRM + contexto)        │   (detectores, estados, observación)
Diseños / Marca / Calendario  ─►  creative.module          │                          CreativeDesign, BrandProfile…
Publicidad (7 pestañas)       ─►  ads.module  ─────────────┴─► common/ads/*              AdAccount, AdEntity,
                                   (cuentas, sync, auditoría,     provider.ts (contrato)   AdInsightDaily, AdSyncRun,
                                    Autopilot, revenue, briefs)   meta-ads-provider.ts     AdSettings, AdRule,
                                                                  demo-provider.ts         AdActionLog, AdBrief
                                                                  registry.ts (Google/TikTok pendientes)
```

- **Código determinista** para todo lo crítico: métricas, comparaciones, umbrales, permisos, límites, estados, idempotencia, auditoría.
- **IA**: no se usa en estos flujos. Los textos de las oportunidades son plantillas deterministas con los datos reales.
- **Aislamiento**: la empresa sale siempre de la sesión. Las plataformas pueden pasar `companyId`. Toda consulta filtra por `companyId` y los ids que llegan se verifican contra la empresa.

## 2. Reutilizado (no duplicado)

| Pieza existente | Uso |
| --- | --- |
| `common/crypto` (AES-256-GCM) | Tokens de cuentas publicitarias |
| `common/meta-publish.ts` (`oauthUrl`, `exchangeCode`, `signState`) | OAuth de Meta Ads (con `scopes` propios) |
| `AuditService` | Registro de conexiones, acciones y correcciones |
| `Contact.originJson` (`chat-origin.ts`) | Atribución directa anuncio → contacto (ID del anuncio en el referral de clic a WhatsApp) |
| `ReactivationService.candidates` | Clientes inactivos para el Radar |
| Embudos (`pipelines.ts`), `Order` (`PAID` / `entregado`) | Etapas y ventas confirmadas |
| `@nestjs/schedule` | Sincronización cada 6 h, reglas, observación de resultados |

## 3. Modelos nuevos (Prisma, Mongo)

`AdAccount`, `AdEntity`, `AdInsightDaily`, `AdSyncRun`, `AdSettings`, `AdRule`, `AdActionLog`, `AdBrief`, `Opportunity`, `CompanyContext`.

No hay migraciones destructivas: Mongo crea las colecciones al primer uso. **Hay que correr `npx prisma db push --skip-generate`** para crear los índices únicos (`dedupeKey`, `idempotencyKey`, `companyId+provider+externalId`, `accountId+level+externalId(+date)`). Sin ellos, el código igual evita duplicados consultando antes, pero el índice es la garantía final.

## 4. Variables de entorno

```
META_APP_ID=""                 # ya existía (también se puede guardar desde DevTools)
META_APP_SECRET=""
META_ADS_API_VERSION="v25.0"   # Meta retira versiones: revisar cada año
ADS_CRON_DISABLED=""           # "1" apaga la sincronización y las reglas automáticas
OPPORTUNITIES_CRON_DISABLED="" # "1" apaga la observación y la detección diaria del CRM
```

## 5. Conectar Meta Ads

1. En la app de Meta (developers.facebook.com) agregar el producto **Marketing API** y pedir en App Review: `ads_read`, `ads_management`, `business_management`.
2. Agregar como URI de redirección OAuth válida: `https://<dominio-web>/api/public/ads/meta/callback`.
3. Con `META_APP_ID` y `META_APP_SECRET` configurados, en *Publicidad → Cuentas* aparece **Continuar con Facebook**. El cliente elige sus cuentas publicitarias y las conecta.
4. Alternativa sin App Review: **conexión con token** (usuario del sistema de Business Manager con `ads_read`). Se valida que el token tenga acceso a esa cuenta.
5. Una cuenta publicitaria solo puede estar conectada en una empresa a la vez.

La creación de campañas usa `name`, `objective` (OUTCOME_*), `status=PAUSED`, `special_ad_categories=[]` e `is_adset_budget_sharing_enabled=false`. COP no lleva decimales (offset 1) y USD sí (offset 100). Esto se verificó en la documentación oficial de Meta en octubre de 2026.

## 6. Google Ads y TikTok Ads (pendientes)

Ya existe el contrato (`AdsProvider`) y un adaptador que **declara qué falta**, sin endpoints inventados.

- **Google Ads**: developer token aprobado, cliente OAuth con el alcance de Google Ads, MCC si aplica. Adaptador: GAQL para reportes y `mutate` para pausar.
- **TikTok Ads**: app aprobada en TikTok for Business Developers (Marketing API), OAuth del anunciante (`advertiser_id`). Adaptador: reportes integrados y actualización de estado.

## 7. Controles de dinero y autonomía

- **Autonomía** (por empresa): `ANALYSIS` (por defecto, solo alertas), `RECOMMEND` (propone; una persona aprueba) o `AUTHORIZED` (ejecuta solo **pausar**, si el admin lo habilitó).
- El Autopilot **nunca** activa campañas ni sube presupuestos.
- Reanudar, revertir una pausa y crear campañas exigen `confirm: true` de una persona. Las campañas se crean **en pausa**.
- La **pausa global** detiene todo el Autopilot.
- Antes de ejecutar solo, se verifican: datos frescos (`maxDataAgeHours`), token vigente, que el elemento esté activo, que pertenezca a la empresa y que no se haya ejecutado ya (idempotencia por regla + elemento + día).
- **Tope diario** (`maxDailyBudget`): BackOffice no crea propuestas por encima de él.

## 8. Radar comercial (Oportunidades)

| Regla | Fuente | Acción |
| --- | --- | --- |
| `FOLLOW_UP_PENDING` (≥3 chats con el último mensaje del cliente, entre 24 h y 30 días) | CRM | Lista de seguimiento (sin envíos automáticos) |
| `STALLED_LEADS` (≥5 contactos en la 1.ª etapa, 7 a 60 días, sin actividad hace 7) | CRM | Lista de seguimiento |
| `DORMANT_CUSTOMERS` (≥3 que compraron y no volvieron) | CRM | Ir a Reactivación |
| `PRODUCT_GROWTH` (+40 %, ≥10 unidades) | CRM | Hipótesis: crear publicación |
| `MEASUREMENT`, `CPR_UP`, `SPEND_NO_RESULTS`, `SPEND_CONCENTRATION`, `AD_ISSUES`, `SPEND_SPIKE`, `LEAD_TRACKING`, `LEAD_QUALITY` | Anuncios (+ CRM) | Pausar o revisar |

**Estados:** `NEW` → `REVIEWING` → `PREPARED` / `NEEDS_APPROVAL` → (actuar) → `OBSERVING` → `RESULT`. También `SNOOZED` y `DISMISSED`.

- Un clic **no** registra un resultado. El resultado lo mide el sistema días después: 3 días para pausas, 7 para métricas y seguimientos, 21 para inactivos. Siempre lleva la aclaración de que muestra lo ocurrido después, sin probar causalidad.
- La persona puede anotar un resultado, que queda como **dato declarado**, separado de lo medido.
- Si la condición desaparece sola, queda registrada como «ya no se detecta», no como «resuelta».
- La evidencia se etiqueta como **suficiente**, **indicio inicial** o **faltan datos**. No hay porcentajes de confianza ni dinero «perdido» o «recuperable».

## 9. Experiencia progresiva

- **Inicio de Creative:** la oportunidad más relevante (solo REAL; una demostración nunca es «lo más importante hoy»), «¿Qué necesitas hoy?», tus logros y «Lo que BackOffice sabe».
- **Intenciones que no bloquean:** si falta algo, llevan al paso que lo habilita (por ejemplo, conectar WhatsApp o registrar pedidos).
- **Logros útiles** (no tareas): primera pieza creada; primera pieza exportada o publicada; primera mejora identificada con evidencia; primera oportunidad atendida; primer resultado medido. No restringen nada.
- **Tarjeta de oportunidad, cinco preguntas:**
  - **qué pasa:** el resumen;
  - **cómo lo sabemos:** el origen y el primer hecho;
  - **por qué importa;**
  - **qué hacer ahora:** una acción principal, con las secundarias discretas;
  - **qué pasó después:** distingue lo medido por BackOffice de lo declarado por el usuario.
  La evidencia completa queda plegada. El texto sale de `common/opportunities/present.ts` (plantillas deterministas, con pruebas).
- **Continuidad:** desde un seguimiento se abre cada chat (`/app/inbox?open=`); los clientes inactivos llevan a Reactivación y el seguimiento de leads a Integraciones.
- **Editor:** «Edición rápida» (textos en orden de lectura y fotos) cuando no hay nada seleccionado; las opciones avanzadas quedan plegadas. Si falla el guardado aparece «Reintentar» y los cambios se conservan en el navegador.
- **Medición** (`CompanyContext.progressJson`, sin datos personales): primera visita, primera intención, primer valor (oportunidad real vista, primera exportación o primera acción), primera acción, minutos hasta el primer valor y abandonos (diálogo de actuar cancelado, brief de campaña sin propuesta).

## 10. Integración futura de IA

`common/ai/creative-assist.ts` define `AssistProvider` (tareas `EXPLAIN_OPPORTUNITY` y `COPY_VARIANTS`), la validación de la salida y `runAssist`. `runAssist` pasa siempre por el libro de créditos: reserva, y después consume si la salida es válida o libera si es inválida o hubo una falla técnica. Un reintento con la misma clave no vuelve a procesar ni a cobrar.

**Hoy no hay ningún proveedor activo** (`providerFromEnv()` devuelve `null`) y ninguna pantalla depende de esto. Para activarlo hay que implementar un `AssistProvider` con el proveedor elegido, devolverlo desde `providerFromEnv` según las variables de entorno y exponer un endpoint con autorización y límite de solicitudes.

## 11. Pruebas

`apps/api/test/ads.spec.ts` (32) y `apps/api/test/opportunities.spec.ts` (21) cubren:

- Adaptador de Meta: paginación, errores, monedas y creación en pausa.
- Sincronización sin duplicados y actualización por atribución tardía.
- Separación entre datos REAL y DEMO.
- Aislamiento entre empresas en cuentas, entidades, reglas, acciones, briefs, oportunidades y contactos.
- Guardia del Autopilot, idempotencia, fallos del proveedor, confirmaciones y tope de presupuesto.
- Atribución sin coincidencias débiles.
- API de conversiones: consentimiento y hash.
- Estados del Radar, observación de resultados y contexto.
- Presentación de cada oportunidad, logros, intenciones e integración de IA con créditos.

## 12. Despliegue y reversión

- **Despliegue**: `prisma db push`, configurar variables y desplegar la API y la web.
- **Reversión**: `ADS_CRON_DISABLED=1` y `OPPORTUNITIES_CRON_DISABLED=1` apagan todo lo automático sin tocar datos. Revertir el commit quita las pantallas. Las colecciones nuevas no afectan a las existentes.
- **Recuperación**: las sincronizaciones quedan en `AdSyncRun`. Una que quedó en `RUNNING` más de 15 minutos no bloquea la siguiente.
- **Observabilidad**: `AdSyncRun` (errores de sincronización), `AdActionLog` (todo cambio con la respuesta del proveedor) y el `AuditLog` general.

## 13. Costos operativos

- Meta Marketing API: sin costo directo; tiene límites de solicitudes, que se manejan como `RATE_LIMIT` y se reintentan en la siguiente vuelta.
- Base de datos: unas 60 filas diarias por anuncio y día sincronizado (aproximadamente 1 KB cada una).
- No se usa IA en estos flujos, así que no consumen créditos.

## 14. Publicidad propia de BackOffice (solo equipo)

Panel de plataforma → **Publicidad** (`/platform/publicidad`), solo para `SUPER_ADMIN` y `DEV`; el rol se exige en el servidor. Es independiente de la Publicidad de los clientes: usa su propia cuenta publicitaria (`META_ADS_CONFIG`, con el token cifrado) y no toca `AdAccount` ni las empresas.

**Pestañas**
- **Resultados**: el tablero de la pauta propia (ver «Resultados» abajo).
- **Configuración** también tiene los umbrales de las alertas de Resultados.
- **Lanzar campaña**: objetivo, presupuesto, fechas, público y anuncio (imagen, texto, título y botón). «Revisar» valida en el servidor y no toca Meta; «Crear en Meta (en pausa)» pide confirmación.
- **Lanzamientos**: activar (con confirmación), pausar, cambiar el presupuesto, reintentar y archivar. También muestra el historial y los IDs de Meta.
- **Configuración**: página que publica, Instagram opcional y **tope de presupuesto diario**.

**Qué se crea** (`common/ads/launch.ts`, determinista y probado): una campaña, un conjunto, un creativo y un anuncio, todo en `PAUSED`.

| Objetivo | Campaña | Conjunto | Botón |
| --- | --- | --- | --- |
| Registros en la web | `OUTCOME_TRAFFIC` | `WEBSITE`, `LINK_CLICKS` | `SIGN_UP` / `LEARN_MORE` / `GET_QUOTE` / `CONTACT_US` |
| Conversaciones por WhatsApp | `OUTCOME_ENGAGEMENT` | `WHATSAPP`, `CONVERSATIONS`, `promoted_object.page_id` | `WHATSAPP_MESSAGE` |

- Público: países, edad y género. `targeting_automation.advantage_audience` siempre se envía, porque Meta lo exige desde v23. Con Advantage+ la edad mínima va de 18 a 25 y no se envía edad máxima.
- El destino de «Registros» es `<PUBLIC_WEB_URL>/registro?utm_source=meta&utm_medium=paid&utm_campaign=<slug del nombre>`, y el creativo lleva `url_tags = utm_id={{campaign.id}}&utm_content={{ad.name}}`: Meta llena el ID de la campaña y el nombre del anuncio en cada clic. No se permiten dos lanzamientos con el mismo slug.
- Los montos se leen según la moneda de la cuenta: en COP «50.000» son cincuenta mil; en USD el último separador es el decimal.

**Controles de dinero**
- Nada se crea activo.
- Activar, subir el presupuesto y activar desde la tabla exigen `confirm: true`.
- Ningún lanzamiento, activación ni cambio de presupuesto pasa el tope diario vigente, y sin tope no se puede lanzar.
- Activar va en el orden anuncio → conjunto → campaña: si algo falla a mitad, la campaña sigue en pausa.
- Cada paso guarda su ID de Meta apenas llega. Si uno falla, el lanzamiento queda en `FAILED` y «Reintentar» continúa desde ese paso sin duplicar.
- Un candado con compare-and-set sobre `PlatformSetting` evita que dos clics simultáneos procesen el mismo lanzamiento.
- Archivar solo lo quita de la lista: en Meta no se borra nada, y una campaña activa hay que pausarla antes.
- Todo queda en `AuditLog`: `ads.launch.create`, `.activate`, `.pause`, `.budget`, `.archive`, `ads.image` y `ads.prefs`.

**Datos**: `PlatformSetting` con las claves `META_ADS_PREFS` y `META_ADS_LAUNCH:<id>`, una por lanzamiento. No hay modelos nuevos, ni índices, ni `db push`.

**Requisitos en Meta antes del primer lanzamiento**
- Token de usuario del sistema con `ads_management`.
- La página asignada a ese usuario del sistema, con permiso para crear anuncios.
- Para WhatsApp, la página vinculada al número de WhatsApp Business.
- Imágenes JPG o PNG de hasta 8 MB. Se suben a la biblioteca de la cuenta (`/adimages`) y se verifican por sus bytes, no por la extensión.

**Versión de la API**: este panel usaba `v21.0` fijo. Ahora usa `META_ADS_API_VERSION` (por defecto `v25.0`), igual que la Publicidad de clientes.

### Resultados (pauta propia)

`GET /platform/ads?range=today|7|14|30|custom&since=&until=&refresh=1` (solo `SUPER_ADMIN` y `DEV`). Lógica pura en `apps/api/src/common/ads/own-funnel.ts`; el servicio en `meta-ads.module.ts` (`overview`). Pantalla: `apps/web/src/pages/platform/PublicidadResultados.tsx`.

**Qué muestra**
- Arriba, qué cuenta se está leyendo (ID, moneda y zona horaria) y hace cuánto se trajeron los datos de Meta.
- Alertas: anuncio o campaña rechazados (con el motivo de Meta), gasto mayor a X sin ningún registro, frecuencia mayor al máximo, CTR del enlace bajo el mínimo (después de N impresiones) y campaña activa que termina en menos de N horas. Los umbrales se editan en Configuración (`PlatformSetting` `META_ADS_ALERTS`).
- Tarjetas: gasto, clics en el enlace (y CPC), registros, costo por registro, empresas que pagan (y CAC) y ROAS.
- Gráfico diario de gasto contra registros (`time_increment=1`).
- Tabla por campaña, desplegable: ritmo (presupuesto total o diario, gastado desde el inicio, % consumido, fin, días restantes y proyección simple al cierre), embudo y comparación de sus anuncios (gasto, clics, CTR, CPC, video 3 s, 25/50/75/100 %, ThruPlay, visitas, registros, costo por registro, empresas que pagan). Resalta el anuncio con mejor costo por registro.
- «Sin atribuir»: lo que llegó desde Meta y no cruzó con ninguna campaña, con sus utm. Se puede asignar a una campaña desde ahí.
- Registros atribuidos: fecha, empresa (con enlace a su ficha), rubro, estado (pagó, activa, onboarding), campaña, anuncio y por qué se atribuyó.

**Embudo** (por sesión de registro, `SignupSession`): visitas (cada navegador que abre `/registro`) → empezaron → registros completados (`DONE`) → empresas creadas → empresas que pagan (pago Wompi `APPROVED` con factura) → ingreso cobrado a la fecha. Pagos en otra moneda cuentan como «paga» pero no suman al ingreso ni al ROAS; la pantalla lo avisa.

**Derivados**: CTR del enlace, CPC, CPM, costo por registro, CAC y ROAS. Si el denominador es 0, o no hay gasto, el valor es `null` y la pantalla muestra «—».

**Cuándo un registro cuenta para una campaña** (de lo más seguro a lo menos):
1. `utm_id` igual al ID de la campaña.
2. `utm_campaign` de un lanzamiento hecho desde el panel.
3. Asignación manual campaña ↔ `utm_campaign` (`PlatformSetting` `META_ADS_UTM_MAP`, `PUT /platform/ads/mappings`). Un mismo `utm_campaign` no puede estar asignado a dos campañas.
4. `utm_campaign` que trae el enlace de destino de un anuncio de esa campaña, leído de Meta (`creative{object_story_spec,url_tags,asset_feed_spec}`). Así se cruzan solas las campañas creadas en el Administrador de anuncios.
5. `utm_campaign` igual al nombre de la campaña, normalizado.

Si un `utm_campaign` apunta a dos campañas en el mismo paso, no se adivina: queda «Sin atribuir». El anuncio sale de `utm_content` (ID, nombre o el `utm_content` del enlace del anuncio), siempre dentro de la campaña ya elegida. Cuenta como «desde Meta» quien llega con `utm_source` facebook/instagram/meta/fb/ig/messenger, con `fbclid` o con un referente de Facebook o Instagram.

**Captura en el registro**: además de `utm_source` y `utm_campaign`, se guardan `utm_medium`, `utm_content`, `utm_id`, `fbclid` y la primera página (`landingPath`). Son campos opcionales y de primer toque: lo que trajo a la persona la primera vez no se reemplaza. Los valores dinámicos sin reemplazar (`{{ad.name}}`) se descartan.

**Meta**: una llamada por nivel (cuenta, campañas, conjuntos, anuncios, insights por campaña, por anuncio, por día, totales de la cuenta y gasto desde el inicio), en la zona horaria de la cuenta. Caché de 12 minutos en memoria; «Actualizar» la salta. Todo es lectura: no se agregó nada que gaste dinero (pausar y activar siguen en la tabla, con `confirm: true`).

**Fechas**: «hoy» y los límites del rango se calculan con `Intl` en la zona de la cuenta (`America/Bogota` si no hay cuenta), nunca con `toISOString`. El rango personalizado llega hasta 90 días.

**Errores de Meta**: token vencido (190), permisos (10/200/294), cuenta inexistente o sin acceso (100) y límite de consultas se explican en la pantalla. La respuesta nunca es un 500, y lo de BackOffice se sigue mostrando.

**Base de datos**: `SignupSession` suma `utmMedium`, `utmContent`, `utmId`, `fbclid`, `landingPath` (opcionales, los registros viejos no cambian) y el índice `@@index([createdAt])`. En producción hace falta `npx prisma db push --skip-generate` para crear ese índice. Sin él funciona igual, solo más lento con volumen.

**Configuración en Render**: el token conectado (Publicidad → Conectar Meta Ads) debe ser de un usuario del sistema con `ads_read` sobre la cuenta que se quiere leer (hoy `act_1397864565500673`, COP, America/Bogota). Para lanzar y pausar desde el panel también hace falta `ads_management`. La pantalla dice arriba qué cuenta está leyendo.

**Para los anuncios creados en el Administrador de anuncios**: usar como URL `…/registro?utm_source=meta&utm_medium=paid_social&utm_campaign=<nombre_corto>` y en «Parámetros de URL» `utm_id={{campaign.id}}&utm_content={{ad.name}}`. La tarjeta «Enlace con seguimiento» los arma y los copia.

### Fase 2 (pendiente, no implementada)

Píxel de Meta y Conversions API enviando `CompleteRegistration` al completar el registro y `Purchase` al aprobarse un pago, para que Meta optimice por registros y no por clics. Antes hace falta:
- Aviso de cookies con consentimiento (el píxel no se carga sin aceptar).
- Actualizar la política de privacidad (Ley 1581): qué se envía a Meta, con qué finalidad y cómo oponerse.
- Enviar los eventos del servidor con `event_id` para deduplicar con el píxel, y datos del usuario solo con hash.

**Pruebas**: `apps/api/test/platform-ads.spec.ts` (32, con un Meta falso, sin llamadas reales: incluye el caso real de la campaña de prueba de 3 días, cruce por `utm_id`, asignación manual, «Sin atribuir», denominadores en cero, zona horaria, errores de Meta, caché, ritmo, estados y alertas), `apps/web/src/pages/platform/PublicidadLanzar.test.tsx` (6) y `apps/web/src/pages/platform/PublicidadResultados.test.tsx` (7).
