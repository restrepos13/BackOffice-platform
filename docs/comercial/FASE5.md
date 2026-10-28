# Administración comercial SaaS · Fase 5

Documento operativo, sin secretos.

## 1. Estado inicial (auditoría)

| Área | Encontrado |
| --- | --- |
| Catálogo | **Un solo modelo `Plan`**, con varias líneas: COMIDAS, WEBCAM, SERVICIOS, VENTAS y WPP en COP, y PRO en USD, inactiva. Los complementos (`addons.ts`) y los paquetes de IA son otros tipos de producto, no planes paralelos. Al plan le faltaban descripción, productos incluidos y ventana de venta. |
| Suscripción | No existía. `Company.status` era texto libre (ONBOARDING, TRIAL, ACTIVE…) que la plataforma cambiaba sin transiciones ni historial. **Suspender no restringía nada.** |
| Venta | Manual: pedido de plan → el equipo cobra por QR o transferencia → «Activar». La activación no era atómica. Wompi está integrado pero se muestra como «próximamente». |
| Wompi | Firma verificada. Pero un evento tardío (PENDING) podía pisar un APPROVED, no se validaba el monto y la acreditación de paquetes de IA tenía una carrera. |
| Facturas | Se emiten a mano. Emitir dos veces a la vez podía crear dos facturas del mismo mes. No hay cron de facturación. |
| Límites | Usuarios y bots, protegidos contra concurrencia desde la fase 1. **Canales sin esa protección.** Créditos de IA: doble descuento posible con trabajos duplicados y sobreuso de lo incluido con consumos simultáneos. |
| Catálogo (riesgos) | Borrar un plan en uso dejaba contratos sin condiciones, y `GET /plans` mostraba a cualquier cliente cuántas empresas tiene cada plan. |
| Atlas (conteo de solo lectura, 27-oct-2026) | 9 empresas: 5 ONBOARDING sin plan y 4 ACTIVE con plan. 0 pagos, 0 facturas, 0 pedidos. Sin índice único en `Invoice`; `Payment.reference` sí es único. |

## 2. Fuente única de verdad

- **Planes:** `Plan`. Ahora tiene además `description`, `includedProductsJson`, `availableFrom` y `availableUntil`.
  - «A la venta» = activo y dentro de su ventana. Los contratos vigentes no dependen de eso.
- **Lo contratado por la empresa:** `Company.planId`, `productsJson`, `addonsJson`, `customPriceMonthly` (precio pactado) y `billingCycle`.
- **Suscripción:** `Company.subscriptionStatus` más los campos de periodo y cancelación, y el historial en `SubscriptionEvent`.
- **Permisos de usuario:** el rol (`ROLES`).
- **Límites:** `limits.ts` (usuarios y bots), `channel-limits.ts` (canales) y créditos de IA (`ai-access.ts`).

**Compatibilidad.** `subscriptionStatus = null` en las empresas existentes: su estado se **deriva** de `Company.status` sin migrar datos (ONBOARDING → PENDING_ACTIVATION, ACTIVE → ACTIVE, CANCELLED → ENDED). Cada transición actualiza también `Company.status` con el valor que esperan los módulos existentes. Los crons de complementos siguen viendo `ACTIVE` mientras la empresa tenga acceso.

## 3. Ciclo de vida (`common/subscription.ts`)

```
PENDING_ACTIVATION → TRIAL | ACTIVE | ENDED
TRIAL              → ACTIVE | ENDED
ACTIVE             → PAYMENT_PENDING | CANCELED | SUSPENDED
PAYMENT_PENDING    → ACTIVE | GRACE | SUSPENDED | CANCELED
GRACE              → ACTIVE | SUSPENDED | CANCELED
SUSPENDED          → ACTIVE | ENDED
CANCELED           → ACTIVE (deshacer) | ENDED (fin del periodo)
ENDED              → ACTIVE (reactivación de plataforma)
```

**Acceso según el estado**
- Todos los estados dan acceso completo salvo `SUSPENDED` y `ENDED`, que dejan la cuenta en **solo lectura** (`SubscriptionGuard`, en el servidor).
- En solo lectura la empresa siempre puede consultar, entrar a su cuenta, ver su suscripción y pagar.
- El bot no responde y la conversación pasa a una persona.
- **Cancelar la renovación no quita el acceso**: sigue hasta `currentPeriodEnd`.

**Garantías de cada transición**
- Se valida contra la tabla de transiciones.
- Primero se reclama el evento, con `_id` derivado de la clave de idempotencia; luego se cambia la empresa con compare-and-set sobre el estado leído. Si otro cambio llegó primero, se deshace el evento y responde 409.
- Las acciones de plataforma y de la empresa quedan además en `AuditLog`.

**Comportamiento ante cada situación**

| Situación | Qué pasa |
| --- | --- |
| Primer pago o activación de un pedido | El pedido se reclama con compare-and-set (dos clics no activan dos veces). La empresa pasa a `ACTIVE` con evento `ACTIVATE`, y el periodo se fija desde la activación según el ciclo. Si ya estaba activa, queda un evento `PLAN_CHANGE`. |
| Factura emitida | Una sola factura por empresa y mes (`_id` derivado). Si la suscripción está `ACTIVE`, pasa a `PAYMENT_PENDING` sin perder acceso. |
| Pago aprobado (Wompi o manual) | Factura pagada con compare-and-set. `PAYMENT_PENDING`, `GRACE` o `SUSPENDED` vuelven a `ACTIVE`. El periodo pasa a ser el de la factura. |
| Pago rechazado | Evento `PAYMENT_FAILED` sin cambiar el estado. Aparece como problema en el panel. |
| Webhook duplicado | Los efectos se aplican una sola vez (`Payment.effectsAppliedAt` con compare-and-set) y el evento no se repite. |
| Notificación tardía | PENDING no pisa un estado final, y un APPROVED no se cambia solo (un reverso se revisa a mano). |
| Monto o moneda distintos | No se aplica nada: el pago queda `REVIEW` y se audita. |
| Cancelación pedida | `CANCELED` con `cancelAtPeriodEnd`; la empresa puede deshacerla mientras no termine el periodo. |
| Cancelación efectiva | La tarea diaria pasa a `ENDED` cuando vence `currentPeriodEnd`. Si no hay periodo registrado, queda como problema para que el equipo decida. |
| Suspensión por impago | Solo si la política define `dueDays` y `graceDays`: factura vencida → `GRACE` → `SUSPENDED`. **Sin política no se suspende a nadie** (se marca «vencida sin política»). |
| Reactivación | Por pago comprobado o por plataforma (con motivo y confirmación). |

**Lo que no se implementó** por falta de condiciones comerciales: reembolsos, prorrateo, cambio de plan a mitad de periodo con ajuste de precio y vencimiento automático de pruebas. Todo eso queda como **decisión pendiente** (§8).

## 4. Pagos

**Wompi (`payments.module.ts`)**
- La firma se compara en tiempo constante.
- Monto y moneda se verifican; los estados no retroceden.
- Los efectos son idempotentes:
  - factura: compare-and-set;
  - paquete de IA: `_id` del lote derivado de la referencia de pago;
  - suscripción: evento con clave.
- No se confía en la redirección del navegador: solo en el webhook firmado.
- No se guardan datos de tarjeta (los maneja Wompi).

**Pago manual** (`POST /subscriptions/invoices/:id/manual-payment`, solo `SUPER_ADMIN`)
- Exige método y confirmación expresa de que el dinero se verificó.
- Crea un `Payment` `MANUAL` con `_id` derivado.
- Queda auditado y reactiva si correspondía.

**Recurrencia.** **Wompi no se usa hoy para débito automático**, y BackOffice no cobra nada solo. Por eso el portal **no muestra una «próxima fecha de cobro»**: dice que los cobros los coordina el equipo.

**Estados Unidos.** Para cobro recurrente a clientes de EE. UU. haría falta un proveedor con suscripciones y tarjetas internacionales (p. ej. Stripe). No se agregó.

## 5. Límites y consumo

**Canales.** Además de revisar antes, se verifica después de crear. Si dos altas simultáneas superan el límite, se conservan las primeras por orden de creación y se deshace la sobrante.

**Créditos de IA**
- Cada consumo se **reclama primero** con `_id` derivado de conversación + ventana de 24 h + unidad: un trabajo duplicado o un reintento no cobra dos veces.
- Lo incluido usa un **contador atómico mensual** (`AiIncludedCounter`): consumos simultáneos no superan el cupo.
- Sin saldo, el reclamo se suelta.

**Conceptos que se distinguen** en el portal, en el panel y en «Economía»:

| Concepto | Fuente |
| --- | --- |
| Consumo medido | `AiCreditUse`, mensajes |
| Créditos incluidos y adicionales | Contador de incluidos y lotes prepago |
| Costo interno de IA | `AiUsageEvent.costUsd` (medido) |
| Mensajería | `metaCostUsd`: tarifa configurada × mensajes **realmente enviados**. Es estimado; los simulados no cuentan |
| Precio cobrado | Facturas pagadas |

**Límites existentes:** no se cambió ninguno.

## 6. Panel global y portal

**Plataforma → Suscripciones** (`/platform/suscripciones`)
- Estado, plan, precio (pactado o del plan), fin del periodo y problemas detectados:
  - pago rechazado, pendiente o vencido sin política;
  - activa sin plan o sin periodo;
  - sobre su límite;
  - prueba vencida;
  - cancelación por cerrar.
- Política de cobro editable.
- Detalle con uso, facturas (y pago manual), economía del mes, historial y cambio de estado con motivo y confirmación. El servidor rechaza los cambios inválidos.

**Mi plan** (empresa): tarjeta «Suscripción» con estado, precio y ciclo, periodo (o «sin fecha registrada»), uso y límites, pagos, historial, cancelar o deshacer, y el aviso de solo lectura. Para cambiar de plan se usa el pedido existente, que el equipo confirma.

**Rutas**

| Ruta | Quién |
| --- | --- |
| `GET /subscriptions` y `GET /subscriptions/:companyId` | SUPER_ADMIN, DEV |
| `GET /subscriptions/:companyId/economics` | SUPER_ADMIN, DEV |
| `GET/PUT /subscriptions/policy` | PUT solo SUPER_ADMIN |
| `POST /subscriptions/run` | SUPER_ADMIN |
| `POST /subscriptions/:companyId/transition` | SUPER_ADMIN |
| `GET /subscriptions/me` | COMPANY_ADMIN, COMPANY_VIEWER |
| `POST /subscriptions/me/cancel` y `POST /subscriptions/me/undo-cancel` | COMPANY_ADMIN |

**Catálogo**
- Un plan en uso no se borra (se desactiva).
- Cambiar el precio o la moneda de un plan en uso exige `confirmAffects` y deja en la auditoría «antes → después · N empresas».
- Un plan fuera de venta no se puede pedir.
- El conteo de empresas por plan solo lo ve plataforma.

## 7. Tarea programada

`SubscriptionsService.tick` corre a las 06:15 todos los días. Se apaga con `BILLING_CRON_DISABLED=1` y no corre en pruebas.

**Qué hace**
- Cierra las cancelaciones cuyo periodo terminó.
- Aplica gracia y suspensión solo si la política está definida.

**Garantías**
- Cada movimiento tiene su clave: repetirla no hace nada.
- No cobra ni envía mensajes.
- En desarrollo se recomienda `BILLING_CRON_DISABLED=1`.

## 8. Decisiones comerciales pendientes

1. Días para pagar una factura y días de gracia: sin ellos no hay suspensión automática.
2. Qué hacer al vencer una prueba (hoy solo se marca).
3. Reembolsos, prorrateo y cambio de plan a mitad de periodo.
4. Precio protegido para clientes existentes cuando cambia la tarifa de un plan. Hoy: se confirma a sabiendas, o se usa el precio pactado por empresa.
5. Cobro recurrente automático (Wompi tokenizado u otro proveedor) y proveedor para EE. UU.
6. Si `PENDING_ACTIVATION` debe tener acceso completo. Hoy lo tiene, como antes, porque las empresas se configuran antes de pagar.
7. Criterio de reparto de la infraestructura por empresa, para el margen.

## 9. Esquema

Solo campos opcionales y modelos nuevos; no hay borrados. Se corrió `prisma generate`; **no** se corrió `db push`.

| Modelo | Campos o modelos nuevos |
| --- | --- |
| `Plan` | `description`, `includedProductsJson`, `availableFrom`, `availableUntil` |
| `Company` | `subscriptionStatus`, `currentPeriodStart`, `currentPeriodEnd`, `cancelAtPeriodEnd`, `canceledAt`, `endedAt`, `suspendedAt` |
| `Payment` | `effectsAppliedAt` |
| Modelos nuevos | `SubscriptionEvent` (índice `companyId+createdAt`) y `AiIncludedCounter` |

La idempotencia no depende de índices únicos: usa `_id` derivados y compare-and-set. El índice no único de `SubscriptionEvent` se crea con el `db push` (primero en el piloto).

## 10. Verificación manual (en el entorno piloto aislado)

1. Plataforma → Suscripciones:
   - las empresas existentes aparecen con «estado heredado»;
   - con la política sin definir, la tarjeta dice «Pendiente de definir».
2. Activar un pedido de plan en Ventas. En Suscripciones, la empresa queda «Activa» con periodo y evento `ACTIVATE`.
3. Emitir la factura del mes: pasa a «Pago pendiente». «Registrar pago manual» con soporte: vuelve a «Activa» y el pago aparece en «Mi plan».
4. Suspender con motivo:
   - con la empresa, cualquier cambio responde «solo lectura»;
   - «Mi plan» lo dice;
   - el bot deja la conversación para una persona.
5. Con la empresa: «Cancelar la renovación» → sigue con acceso; «Seguir con mi suscripción» lo deshace.
