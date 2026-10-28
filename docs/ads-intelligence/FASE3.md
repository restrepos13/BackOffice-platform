# Ads Intelligence · Fase 3

Documento operativo, sin secretos. Complementa [creative-ads.md](../creative-ads.md).

## 1. Estado de las integraciones

| Integración | Estado | Verificado con |
| --- | --- | --- |
| Meta Ads: cuentas, campañas, conjuntos, anuncios, métricas diarias, alcance y frecuencia del periodo, pausar/reanudar | Implementado | **Solo mocks** (Meta falso en pruebas). No hay una cuenta publicitaria real conectada en el entorno revisado: Atlas tiene 1 cuenta, y es DEMO. |
| Meta Lead Ads (webhook `leadgen` + lectura del lead) | Implementado | **Solo mocks.** Faltan, fuera del código: App Review de `leads_retrieval`, página conectada y suscrita al campo `leadgen`. |
| Proveedor DEMO | Implementado | Pruebas. Siempre `mode=DEMO` y separado de los datos reales. |
| Envío de conversiones a Meta (CAPI) | **No implementado** | Hay utilidades de armado y hash (`conversions.ts`), pero ningún envío. Es un alcance aparte que necesita diseño, autorización y pruebas. |
| Google Ads, TikTok Ads | **No implementado** | Solo el contrato y los requisitos (§8). La interfaz los muestra como «Pendiente de habilitar». |

## 2. Sincronización (`ads.module.ts` → `sync`, `common/ads/sync-policy.ts`)

**Una sola sincronización a la vez por cuenta.** Se toma un candado con compare-and-set (`AdAccount.syncLockUntil`, 15 min) y se libera siempre en `finally`. El candado que existía antes (consultar si había una `RUNNING` y luego crear) tenía una carrera.

**Orden de la sincronización**
1. Se leen y guardan los elementos (campañas, conjuntos y anuncios).
2. Se piden las métricas en tramos de 15 días, guardando cada tramo apenas llega.
3. Al final se piden el alcance y la frecuencia de 7 y 30 días, que son opcionales.

**Nunca se borra nada.** Si un tramo falla, la corrida queda `PARTIAL`: lo ya guardado se conserva y `lastSyncAt` no avanza, así el siguiente intento vuelve a cubrir el hueco.

**Hallazgos y datos incompletos.** Los hallazgos solo se recalculan después de una corrida `OK`. Con datos incompletos no se juzga nada y ningún hallazgo se cierra como «desaparecido».

**Paginación.** Si Meta tiene más páginas que el tope, falla como `INCOMPLETE`: no se guarda una parte como si fuera el total. El subcódigo 1487534 de Meta (rango demasiado grande) también es `INCOMPLETE`.

**Errores y siguiente intento** (en `AdAccount`: `lastErrorKind`, `lastSyncStatus`, `nextSyncAt` y `syncFailures`):

| Tipo | Estado de la cuenta | Siguiente intento |
| --- | --- | --- |
| `AUTH` (token vencido o revocado) | `EXPIRED` | Ninguno: hay que reconectar |
| `PERMISSION` | `ERROR` | A las 24 h |
| `RATE_LIMIT` | Sigue `CONNECTED` | 1 h, 2 h, 4 h… hasta un máximo de 12 h |
| `INCOMPLETE` / `PROVIDER` | Sigue `CONNECTED` | 30 min, 1 h… hasta un máximo de 12 h |
| Sin error | `CONNECTED` | A las 6 h |

**Historial.** `GET /ads/accounts/:id/syncs` devuelve las últimas 10 corridas, con los tramos y los avisos de cada una.

**Credenciales.** Se guardan cifradas. La API devuelve solo `credential: "Guardada cifrada · no se muestra"` y los permisos. Las pruebas verifican que el token no aparezca en cuentas, corridas ni errores.

## 3. Identidad e idempotencia sin índices

Revisé Atlas en solo lectura el 27-oct-2026:
- **ninguna** colección de Ads tiene índices únicos (solo `_id_`);
- 0 duplicados lógicos;
- los únicos datos son DEMO (1 cuenta, 12 elementos y 295 filas de métricas).

Por eso la unicidad ya no depende del índice. El `_id` de cada fila nueva se deriva de su clave lógica, y Mongo siempre garantiza que `_id` sea único:

| Fila | Clave lógica | `_id` |
| --- | --- | --- |
| Cuenta | empresa + plataforma + ID externo | `ada_<sha256>` |
| Elemento | cuenta + nivel + ID externo | `ade_…` |
| Métrica diaria | cuenta + nivel + ID externo + día | `adi_…` |
| Acción | clave de idempotencia | `adl_…` |
| Hallazgo | dedupeKey | `opp_…` |
| Lead | leadgen_id | `adlead_…` |

**Escritura concurrente.** `createMany` de un lote que choca con `_id` existentes cae a inserción fila por fila, omitiendo las que ya están. Las filas viejas con id `cuid` siguen funcionando, porque se encuentran por su clave lógica antes de insertar.

**Pruebas.** El mock simula Atlas sin índices (`createMockPrisma({ atlasWithoutIndexes: true })`) e incluye:
- sincronizaciones simultáneas;
- lotes concurrentes;
- auditorías simultáneas;
- aprobaciones simultáneas.

### Cambios de esquema pendientes y cómo aplicarlos

**Lo que no requiere índices.** En el esquema se agregaron solo campos opcionales y el modelo `AdLead`. Mongo crea la colección al primer uso. Se corrió `prisma generate`; **no** se corrió `db push`.

**Lo que hace `db push`.** Crea los índices declarados que hoy faltan:
- `AdAccount(companyId, provider, externalId)` único;
- `AdEntity(accountId, level, externalId)` único;
- `AdInsightDaily(accountId, level, externalId, date)` único;
- `AdActionLog.idempotencyKey` único;
- `Opportunity.dedupeKey` único;
- `AdLead(companyId, receivedAt)`;
- además de los no únicos.

**Procedimiento seguro**
1. **Primero en el entorno piloto aislado**, nunca en el Atlas compartido:
   1. Correr el conteo de duplicados en solo lectura: el aggregate por la clave lógica que figura en la tabla de arriba.
   2. Si hay duplicados, resolverlos a mano conservando la fila con `syncedAt` más reciente. El índice único falla si existen.
   3. Correr `npx prisma db push --skip-generate`.
2. En producción, en una ventana sin sincronizaciones (`ADS_CRON_DISABLED=1` mientras dura): el mismo conteo y luego `db push`.
3. Revertir no exige nada: el código no depende de los índices. Solo son la garantía final.

## 4. Métricas (`common/ads/metrics.ts`)

**Cálculos a partir de lo que reporta la plataforma**

| Métrica | Fórmula |
| --- | --- |
| CTR | `clics / impresiones × 100` |
| CPC | `gasto / clics` |
| CPM | `gasto / impresiones × 1000` |
| Costo por resultado | `gasto / resultados del tipo de la campaña` |
| ROAS de la plataforma | `valor de compras que ella atribuye / gasto` |

Si el denominador es 0 o falta, el resultado es `null` (no 0).

**Resultado según el objetivo** (`resultTypeFor`)

| Objetivo | Cuenta como resultado |
| --- | --- |
| ENGAGEMENT / MESSAGES | conversaciones iniciadas |
| LEADS | leads + conversaciones |
| SALES | compras |
| TRAFFIC | clics en el enlace |
| AWARENESS / REACH | ninguno: no se calcula costo por resultado |
| Desconocido | la suma reportada (comportamiento anterior) |

**Mezcla de objetivos.** Si un periodo mezcla objetivos, el total no tiene costo por resultado único (`null`, con una nota que dice por qué) y la gráfica muestra solo el gasto. Antes se sumaban leads, chats y compras.

**Alcance y frecuencia.** No se suman día a día, porque el alcance son personas únicas.
- Se muestran solo con lo que reportó la plataforma para **el mismo periodo**: 7 o 30 días terminando en el último día sincronizado.
- Se muestran por cuenta (cuando hay una sola) o por campaña.
- En cualquier otro caso: «no disponible», con el motivo.

**Variaciones.** Solo entre periodos comparables: el anterior debe tener datos en al menos el 80 % de los días del actual. Además, los resultados solo se comparan si los dos periodos miden el mismo tipo.

**Corrección en el Autopilot.** La regla `FREQUENCY` usaba impresiones divididas por el alcance diario máximo, lo que la sobreestima y podía proponer pausas falsas. Ahora usa solo la frecuencia reportada del periodo. Por eso exige nivel campaña y una ventana de 7 o 30 días. La prueba que fijaba el valor anterior se actualizó a este comportamiento.

## 5. Hallazgos (`common/ads/findings.ts`)

Cada hallazgo trae:
- hechos, interpretación, supuestos y faltantes;
- incertidumbre;
- **regla aplicada** (`explanation.rule`);
- periodo y evidencia numérica;
- nivel de evidencia (`SUFFICIENT`, `INITIAL` o `MISSING_DATA`);
- fecha de detección (`firstSeenAt`) y estado de seguimiento.

**Reglas**

| Regla | Qué detecta |
| --- | --- |
| `MEASUREMENT` | Gasto sin ningún resultado del tipo buscado en 14 días |
| `CPR_UP` / `CPR_DOWN` (nueva) | El costo por resultado sube o baja ≥ 30 % entre semanas, con ≥ 5 resultados y ≥ 6 días de datos por lado |
| `SPEND_NO_RESULTS` | Comparado con el costo **del mismo tipo de resultado** en la cuenta |
| `SPEND_CONCENTRATION` | Un anuncio se lleva el gasto con peor costo que sus pares |
| `AD_ISSUES` | Anuncios rechazados o con problemas |
| `SPEND_SPIKE` | Picos de gasto diario |
| `SPEND_DROP` (nueva) | Último día **completo** con gasto < 30 % del promedio y campañas activas |
| `LEAD_TRACKING` | Conversaciones reportadas por la plataforma, sin contactos de anuncios en el CRM |
| `CONVERSATION_GAP` (nueva) | El CRM registra menos de la mitad de las ≥ 20 conversaciones que reporta la plataforma |
| `LEAD_QUALITY` | Caída en la progresión del embudo |

**Deduplicación**
- La clave es estable por regla + elemento; antes incluía la semana, así que el mismo hallazgo se recreaba cada día.
- Si la condición desaparece, el sistema lo cierra.
- Si vuelve, se reabre la misma fila como episodio nuevo, con una nota en el historial.
- Uno descartado por una persona sigue descartado.

**Migración.** Los hallazgos guardados con las claves anteriores se cierran solos («ya no se detecta») en la siguiente auditoría. Hoy son 4 y todos DEMO.

## 6. Atribución (`common/ads/revenue.ts`, `GET /ads/revenue`)

Solo se aceptan identificadores:
- el ID del anuncio en el primer mensaje de WhatsApp (referral);
- el ID del anuncio en un formulario de Lead Ads.

Nunca se usan fechas cercanas ni nombres parecidos.

| Estado | Cuándo |
| --- | --- |
| `ATTRIBUTED` | El ID está en las cuentas sincronizadas: se conocen anuncio, conjunto y campaña |
| `PARTIAL` | El ID no está en las cuentas conectadas, o solo llegó el enlace o el `ctwa_clid` |
| `UNATTRIBUTED` | El origen dice anuncio o publicación, sin identificador utilizable |

Los contactos directos no entran: no vinieron de un anuncio.

**Ventas.** Solo se cuentan ventas confirmadas (pagadas o entregadas) de contactos atribuidos y posteriores a su llegada. La facturación total del negocio se muestra aparte y no se usa para el ROAS.

**Limitaciones**
- Un cliente que ya existía y vuelve por un anuncio conserva su primer origen.
- La campaña de un anuncio que no se sincronizó es desconocida.
- Meta cuenta las conversaciones por la fecha del clic y el CRM por la del primer mensaje.

## 7. Meta Lead Ads (`common/ads/leads.ts`, `modules/ads-leads.ts`)

**Entrada.** Llegan por el mismo webhook firmado de Meta (`/api/webhooks/:slug/meta`, objeto `page`, campo `leadgen`). Solo se aceptan páginas que la empresa del slug tiene conectadas (integraciones `META_SOCIAL`, `MESSENGER` o `INSTAGRAM`); un lead de otra página se ignora.

**Deduplicación.** El `_id` sale del `leadgen_id`, así que los reintentos de Meta no duplican nada. La lectura de cada lead se toma con compare-and-set.

**Lectura de datos personales.** Se piden a Graph con el token de esa página.
- Sin token, o si Meta niega el permiso: el lead queda en `PENDING_PERMISSION` con sus IDs (sirven para atribuir) y **no se crea ningún contacto**.
- Con datos: se crea el contacto, o se une por teléfono o correo. El origen queda `{kind: AD, via: LEAD_FORM, sourceId: <ad_id>}`, solo si el contacto no tenía uno.
- Si el contacto es nuevo, se emite `contact.created`, que llega al motor de automatizaciones.

**Qué se guarda en `AdLead`.** Solo los identificadores y los **nombres** de los campos. Los valores van al contacto.

**Endpoints**
- `GET /ads/leads` (lectura).
- `POST /ads/leads/:id/fetch` (escritura): pide los datos otra vez.

**Bloqueos externos**
- App Review de `leads_retrieval`, además de `pages_manage_metadata` para suscribir la página.
- Suscribir cada página al campo `leadgen`.
- El token de página guardado en la integración debe incluir ese permiso.

## 8. Acciones (`changeStatus`, `decideAction`, `retryAction`)

**Ciclo de una acción**
1. **Sugerida**: `PROPOSED`, creada por una regla.
2. **Aprobada**: `APPROVED`, con `approvedBy` y `approvedAt`.
3. **Ejecución**: queda en su propio registro, enlazado con `executionLogId`, y termina como:
   - `EXECUTED`: confirmado por la plataforma;
   - `FAILED`: con el error;
   - `SKIPPED`: ya estaba así y no se llamó a la plataforma.
4. **Rechazada**: `REJECTED`, con la persona que rechazó.

**Garantías**
- Aprobar y rechazar usan compare-and-set: dos aprobaciones simultáneas ejecutan una sola vez.
- Antes de ejecutar se verifica que la empresa, la cuenta (`CONNECTED` y con credencial) y el elemento sigan siendo válidos. Con la conexión vencida no se llama a Meta.
- Una ejecución en curso queda `RUNNING`, con compare-and-set desde `PROPOSED` o `FAILED`.
- **Reintentar** (`POST /ads/actions/:id/retry`) usa la misma clave, así que nunca duplica. Reanudar exige confirmación.
- Si la plataforma no confirma el cambio (`success: false`), la acción no se marca como ejecutada.
- El Autopilot solo pausa: hay una prueba que verifica que nunca envía presupuestos ni activa.

## 9. Google Ads y TikTok Ads (requisitos; no implementados)

| | Google Ads | TikTok Ads |
| --- | --- | --- |
| Autenticación | OAuth 2.0 de Google Cloud con el alcance `adwords` + developer token aprobado (nivel básico o estándar) + `login-customer-id` si se opera desde una MCC | App en TikTok for Business Developers con acceso a la Marketing API; OAuth del anunciante (`advertiser_id`) |
| Lectura | GAQL (`GoogleAdsService.SearchStream`) para campaign/ad_group/ad + `metrics.*` con `segments.date` | API de reportes integrados (BASIC, por día y por nivel) |
| Alcance y frecuencia | Disponibles en reportes de reach para campañas de display/video; no en todas | Disponibles en reportes según el objetivo |
| Pausar | `mutate` de estado (`PAUSED`) | Actualización de estado por nivel |
| Monedas | `micros` (÷ 1.000.000) | Según la cuenta |

**Qué se puede reutilizar** sin abstraer de más:
- el contrato `AdsProvider`;
- `RemoteEntity` y `RemoteInsight`;
- los errores tipados (cada adaptador clasifica los suyos en los mismos tipos);
- la sincronización por tramos, la idempotencia y los hallazgos.

**Qué es propio de cada plataforma**
- objetivos, por lo que hace falta un `resultTypeFor` por proveedor;
- reglas de presupuesto;
- creación de campañas.

**Recomendación:** implementar primero Google (un adaptador de lectura y pausa), y solo con credenciales reales para validarlo.

## 10. Rutas nuevas

- `GET /ads/accounts/:id/syncs`
- `POST /ads/actions/:id/retry`
- `GET /ads/leads`
- `POST /ads/leads/:id/fetch`

Todas bajo `@Products('ADS')`. Las de escritura exigen `SUPER_ADMIN`, `DEV` o `COMPANY_ADMIN`. La empresa sale siempre de la sesión.
