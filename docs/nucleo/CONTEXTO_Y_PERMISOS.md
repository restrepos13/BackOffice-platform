# Núcleo SaaS · contexto de empresa, secciones y permisos

Estado: Fase 1 (octubre 2026). Este documento describe lo que ya está en el código y lo que falta migrar.

## 1. Contexto de empresa (tenant)

La empresa del usuario **no viene del token**: el `JwtAuthGuard` la relee de la base en cada request (con caché corta) junto con rol, estado y `sessionVersion`. Sobre eso, `apps/api/src/common/tenant.ts` concentra las reglas:

| Helper | Uso | Regla |
|---|---|---|
| `requireTenant(user, requested)` | escrituras | Usuario de empresa → siempre su empresa (ignora `requested`). Plataforma → debe elegir una; si no, 403. |
| `tenantFilter(user, requested)` | listados | Igual que `scopeCompanyId`: plataforma sin elegir ve todo (`undefined`); usuario de empresa sin empresa → `'__none__'`. |
| `assertSameTenant(user, resource)` | lecturas/edición por id | 404 si el recurso es de otra empresa (no revela que existe). |
| `assertRefsInTenant(prisma, companyId, refs)` | ids que llegan en el body | `userId`, `customerId`, `contactId`, `pipelineId`, `botId`, `integrationId` deben ser de la misma empresa → 400 «X no pertenece a esta empresa». |

### Huecos corregidos en Fase 1
- Contactos: `assignedToId` y `customerId` de otra empresa.
- Integraciones: `botId` de otra empresa.
- Media: `integrationId` de otra empresa.
- Pedidos manuales: `contactId` de otra empresa.

Cubierto por `apps/api/test/nucleo.spec.ts` (bloque A).

### Plan de migración de las copias restantes
Siguen existiendo ~25 archivos con `scopeCompanyId` o un `private resolveCompany(...)` propio (10 copias de este último). Funcionan bien —la empresa se resuelve en servidor—, pero duplican la regla. Migración propuesta, **módulo a módulo y con su prueba negativa cruzada antes de cada cambio**:
1. Reemplazar `private resolveCompany` por `requireTenant` (mismo comportamiento, cambia solo el mensaje de error de plataforma sin empresa).
2. Reemplazar `scopeCompanyId` por `tenantFilter` (alias exacto: cero cambio de comportamiento).
3. En cada `create/update` que reciba ids de otras entidades, añadir `assertRefsInTenant`.
4. Cuando no quede ninguna copia, marcar `scopeCompanyId` como deprecado.

No se hizo en bloque para no tocar 25 módulos sin pruebas específicas de cada uno.

## 2. Secciones (`modulesJson`) en servidor

`apps/api/src/auth/sections.guard.ts` añade el decorador `@Section(key)` y un guard global (después de Products). Si el controlador declara sección y la empresa no la tiene en `modulesJson` → 403 «Esta sección no está habilitada para tu empresa…». Plataforma, endpoints públicos y controladores sin decorador pasan igual que antes. La caché (30 s) se invalida al editar los módulos de la empresa.

**Aplicado hoy solo a Producciones** (`@Section('productions')`).

### Por qué no a todo
Empresas antiguas usan funciones que no figuran en su `modulesJson` (la lista se armó para el menú, no como permiso). Activar el guard en todos los módulos podría cortarles algo que hoy usan.

### Despliegue propuesto (requiere aprobación)
1. Script de solo lectura que cruce, por empresa, `modulesJson` contra uso real de los últimos 90 días (contactos, pedidos, campañas, reservas…).
2. Completar `modulesJson` de las empresas con uso real y sin la sección (escritura acotada, con respaldo previo, aprobada).
3. Añadir `@Section` módulo a módulo: `orders`, `agenda`/`bookings`, `campaigns`, `gerencia`, `delivery`, `menu`, `production`.
4. Las secciones base (`inbox`, `contacts`, `bots`, `billing`, `team`) quedan siempre activas.

## 3. Tres capas que no hay que confundir

| Capa | Fuente | Dónde se aplica |
|---|---|---|
| Producto contratado | `Company.products` (AUTOMATION, CREATIVE, ADS) | `ProductsGuard` + `@Products` |
| Sección visible | `Company.modulesJson` | Menú + `SectionsGuard` (Producciones) |
| Permiso efectivo | Rol del usuario + `opsProfile` | `RolesGuard` + servicio |

### Matriz de roles (servidor)
| Rol | Lectura | Escritura | Notas |
|---|---|---|---|
| SUPER_ADMIN / DEV | todas las empresas | sí | eligen empresa con `companyId` |
| COMPANY_ADMIN | su empresa | sí | puede invitar y ver invitaciones |
| COMPANY_VIEWER | su empresa | no (salvo lo que su `opsProfile` permita en Producciones) | |
| COMPANY_AREA | solo su área | restringido | fuera de Producciones por RolesGuard |
| COMPANY_COURIER | sus entregas | restringido | no cuenta para el límite de personas |

`opsProfile` (solo para VIEWER) define permisos finos en Producciones (`PROFILE_PERMISSIONS`). Las invitaciones permiten fijarlo; nunca se puede invitar con `opsProfile` a un ADMIN.

## 4. Sesiones: estado y propuesta

**Hoy:** JWT HS256 de 12 h guardado en `localStorage` (`bo_token`). Revocación por `sessionVersion` (cambiar o restablecer la contraseña, desactivar al usuario o el MFA la invalidan; el guard la compara en cada request). El stream SSE recibe el JWT por query string porque `EventSource` no admite headers.

**Riesgos:** un XSS puede leer el token de `localStorage`; el token en la URL del SSE puede quedar en logs de proxy.

**Propuesta (no implementada, requiere aprobación — cambia el login):**
1. Cookie `HttpOnly; Secure; SameSite=Lax` con un access token corto (15 min) + refresh token rotativo guardado en `AuthToken` (hash), revocable.
2. Protección CSRF (doble envío o `SameSite=Strict` en rutas de escritura).
3. Ticket SSE de un solo uso (30 s) emitido por `POST /events/ticket`, en lugar del JWT en la URL.
4. Convivencia: el API acepta Bearer y cookie durante la transición; el web migra después.
