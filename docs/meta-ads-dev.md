# Meta Ads · integración interna de desarrollo

Herramienta **solo para el equipo**, en localhost, para validar la Marketing API
con nuestra app de Meta (modo Development) y nuestra cuenta publicitaria de
pruebas. No es una función para clientes: no aparece en ningún panel de empresa
y sus datos no se mezclan con los de los tenants.

## Qué hace

1. OAuth con la app de Meta (desde el backend, state de un solo uso + cookie).
2. Lista las cuentas publicitarias autorizadas y deja elegir la de pruebas.
3. Sincronización manual: campañas, conjuntos, anuncios e Insights por campaña y
   día (30 o 60 días).
4. Muestra lo guardado, las respuestas crudas de Meta, el historial de
   sincronizaciones con cada llamada (sin credenciales) y el estado de la
   credencial (cifrado, vencimiento, `debug_token`).
5. Desconecta: revoca el permiso de la app en Meta (`DELETE /me/permissions`) y
   borra el token; opcionalmente borra los datos internos.

**Solo lectura.** No pausa, activa ni crea campañas y no toca presupuestos. El
cliente de Graph solo hace GET (más el DELETE de revocación).

## Quién puede usarla

Todo se valida en el backend (`MetaDevGuard`):

- `META_DEV_ENABLED=1` en `apps/api/.env`;
- nunca con `NODE_ENV=production` ni con las variables `RENDER` o `VERCEL`;
- usuario con rol **DEV** (ni SUPER_ADMIN ni roles de empresa).

Cualquier otro caso recibe **404**. La página web (`/dev/meta-ads`) solo existe
en el build local (`import.meta.env.DEV`): el build de producción no la incluye.

## Configuración local

En `apps/api/.env` (no se sube a git):

```
META_DEV_ENABLED=1
META_DEV_APP_ID=                # App ID de la app BackOffice en Meta Developers
META_DEV_APP_SECRET=            # Meta Developers → Configuración → Básica
META_DEV_REDIRECT_URI=http://localhost:5173/api/dev/meta-ads/callback
META_DEV_SCOPES=ads_read,business_management
META_DEV_SYNC_DAYS=30
META_GRAPH_API_VERSION=v25.0
```

`MASTER_ENCRYPTION_KEY` (ya existente) cifra el token con AES-256-GCM.

Son variables **distintas** de `META_APP_ID` / `META_APP_SECRET`: llenar estas no
habilita la conexión de Meta Ads para empresas.

### En Meta Developers (app BackOffice)

1. La app debe tener el producto **Inicio de sesión con Facebook** (Facebook Login).
2. En *Facebook Login → Configuración → URI de redireccionamiento de OAuth
   válidos* agregar exactamente:
   `http://localhost:5173/api/dev/meta-ads/callback`
3. Con la app en modo Development, solo pueden autorizar personas con rol en la
   app (administrador, desarrollador o tester).
4. El usuario que autoriza necesita acceso a la cuenta publicitaria de pruebas.

## Ejecutar

```
pnpm --filter @backoffice/api dev     # API en :4001
pnpm --filter @backoffice/web dev     # web en :5173 (proxy /api → :4001)
```

Entrar con un usuario DEV y abrir `http://localhost:5173/dev/meta-ads`.

## Datos

Colecciones propias, sin `companyId`, con `scope = "DEV_INTERNAL"`:
`MetaDevConnection`, `MetaDevOAuthState`, `MetaDevObject`, `MetaDevInsight`,
`MetaDevSyncRun`. Ningún dashboard, reporte, radar ni cron de empresas las lee.

## Tokens de Meta (documentación oficial, oct-2026)

- El código se cambia por un token corto y ese por uno largo (~60 días).
- No hay refresh token: un token vencido no se renueva; hay que autorizar de nuevo.
- Código 190: subcódigos 463/467 = vencido; 458/460 = revocado o cambio de contraseña.

## Pruebas

`apps/api/test/meta-dev.spec.ts` (simuladas: Graph API es un doble en memoria).
La prueba real contra Meta se hace a mano desde la página interna.
