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
META_ADS_API_VERSION="v24.0"   # Meta retira versiones: revisar cada año
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
- **Resultados**: lo que ya existía (gasto, registros y empresas por campaña, gasto anotado a mano, enlaces UTM).
- **Lanzar campaña**: objetivo, presupuesto, fechas, público y anuncio (imagen, texto, título y botón). «Revisar» valida en el servidor y no toca Meta; «Crear en Meta (en pausa)» pide confirmación.
- **Lanzamientos**: activar (con confirmación), pausar, cambiar el presupuesto, reintentar y archivar. También muestra el historial y los IDs de Meta.
- **Configuración**: página que publica, Instagram opcional y **tope de presupuesto diario**.

**Qué se crea** (`common/ads/launch.ts`, determinista y probado): una campaña, un conjunto, un creativo y un anuncio, todo en `PAUSED`.

| Objetivo | Campaña | Conjunto | Botón |
| --- | --- | --- | --- |
| Registros en la web | `OUTCOME_TRAFFIC` | `WEBSITE`, `LINK_CLICKS` | `SIGN_UP` / `LEARN_MORE` / `GET_QUOTE` / `CONTACT_US` |
| Conversaciones por WhatsApp | `OUTCOME_ENGAGEMENT` | `WHATSAPP`, `CONVERSATIONS`, `promoted_object.page_id` | `WHATSAPP_MESSAGE` |

- Público: países, edad y género. `targeting_automation.advantage_audience` siempre se envía, porque Meta lo exige desde v23. Con Advantage+ la edad mínima va de 18 a 25 y no se envía edad máxima.
- El destino de «Registros» es `<PUBLIC_WEB_URL>/registro?utm_source=meta&utm_medium=paid&utm_campaign=<slug del nombre>`. Resultados cruza la campaña por ese `utm_campaign` exacto. No se permiten dos lanzamientos con el mismo slug.
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

**Versión de la API**: este panel usaba `v21.0` fijo. Ahora usa `META_ADS_API_VERSION` (por defecto `v24.0`), igual que la Publicidad de clientes.

**Pruebas**: `apps/api/test/platform-ads.spec.ts` (14, con un Meta falso, sin llamadas reales) y `apps/web/src/pages/platform/PublicidadLanzar.test.tsx` (5).
