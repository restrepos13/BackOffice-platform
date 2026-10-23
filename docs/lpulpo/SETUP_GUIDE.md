# Piloto LPulpo: guía del entorno aislado

El piloto corre con **su propia base local**. Nunca usa la base habitual de desarrollo, que es la de producción.

## Requisitos

- **Node.js** 20 o 22 (`engines`) y pnpm.
- **MongoDB 7** instalado con Homebrew (`mongod`, `mongosh`). El piloto usa una instancia propia en el puerto **27019**, con replica set de un nodo (Prisma lo exige).
- **Redis local** (Homebrew, puerto 6379). El piloto usa el prefijo de colas `pilot-lpulpo`, así que no comparte trabajos con otra API conectada al mismo Redis.

## Variables (archivo `apps/api/.env.pilot`, no se versiona)

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | `mongodb://127.0.0.1:27019/backoffice_lpulpo_pilot?replicaSet=rs0&directConnection=true` |
| `REDIS_URL` | Redis local |
| `BULLMQ_PREFIX` | Prefijo propio de colas (`pilot-lpulpo`) |
| `JWT_SECRET`, `MASTER_ENCRYPTION_KEY` | Propios del piloto, generados al azar (64 hex para la llave) |
| `PORT` | `4011` |
| `CORS_ORIGIN` | `http://localhost:5180` |
| `ADS_CRON_DISABLED`, `OPPORTUNITIES_CRON_DISABLED`, `BOOKINGS_CRON_DISABLED`, `CALENDAR_CRON_DISABLED` | `1` |
| `PILOT_ADMIN_EMAIL`, `PILOT_ADMIN_PASSWORD`, `PILOT_DEV_EMAIL`, `PILOT_DEV_PASSWORD` | Usuarios iniciales; solo los usa el bootstrap |

- Las llaves de IA, Meta y correo se dejan **vacías a propósito**: así nada sale del entorno. Se declaran vacías porque Prisma carga el `.env` habitual para las variables que falten.
- `scripts/pilot-env.cjs` ejecuta cualquier comando con estas variables y solo con ellas. Antes de ejecutar nada, comprueba que la base sea local y que su nombre contenga «pilot».

## Arranque

```bash
mkdir -p ~/.backoffice-pilot/mongo ~/.backoffice-pilot/logs
```

```bash
mongod --dbpath ~/.backoffice-pilot/mongo --port 27019 --bind_ip 127.0.0.1 --replSet rs0 --fork --logpath ~/.backoffice-pilot/logs/mongod.log
```

La primera vez, inicializa el replica set:

```bash
mongosh --port 27019 --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27019"}]})'
```

API (desde `apps/api`, tras `npm run build`):

```bash
node scripts/pilot-env.cjs node dist/main.js
```

Web (desde `apps/web`):

```bash
VITE_PORT=5180 VITE_API_TARGET=http://localhost:4011 npx vite --port 5180 --strictPort
```

Panel: http://localhost:5180

## Inicializar la base del piloto (revisar el entorno antes)

Estas dos operaciones escriben en la base. **Solo deben correr contra la base del piloto.** Los scripts se niegan si la base no es local o su nombre no contiene «pilot».

1. **Índices y colecciones:**

   ```bash
   node scripts/pilot-env.cjs npx prisma db push --skip-generate
   ```

2. **Empresa LPulpo y usuarios iniciales.** El bootstrap es idempotente y no crea datos comerciales ni de prueba. Exige confirmar el nombre de la base:

   ```bash
   node scripts/pilot-env.cjs sh -c 'PILOT_BOOTSTRAP_CONFIRM=backoffice_lpulpo_pilot npx ts-node --transpile-only prisma/pilot-bootstrap.ts'
   ```

   Si la base ya tiene otras empresas, se niega: no es la base del piloto.

Las credenciales iniciales del entorno local están en `~/.backoffice-pilot/credenciales.txt` (fuera del repositorio, permisos 600).

## Comprobar que el entorno es el del piloto

- **Salud de la API:** `curl localhost:4011/api/health`.
- **Contenido de la base:**

  ```bash
  mongosh --quiet --port 27019 --eval 'db.getSiblingDB("backoffice_lpulpo_pilot").Company.find({}, {slug: 1}).toArray()'
  ```

  Debe mostrar solo `lpulpo`.
- **Arranque del motor:** el log de la API (`~/.backoffice-pilot/logs/api.log`) dice «Worker del motor de Automation arriba».

## Pruebas

| Qué | Comando |
|---|---|
| API | `cd apps/api && npx jest` (sin servicios externos) |
| Web | `cd apps/web && npx vitest run` |
| Tipos | `npx tsc --noEmit -p tsconfig.json` en cada app |
| Build | `npm run build` en cada app |
| Recorrido de punta a punta (API y base reales del piloto; crea y borra dos empresas de prueba) | `cd apps/api && node scripts/pilot-env.cjs npx ts-node --transpile-only prisma/pilot-e2e.ts` |

## Configurar LPulpo

1. Entra con la cuenta de administración de LPulpo. En el primer ingreso se muestran los términos y condiciones; los acepta LPulpo.
2. **Usuarios:** en Equipo, crea a los bookers como «Consulta». En Producciones → Configuración del flujo → Usuarios y permisos, asígnales «Booker» o «Booker que aprueba cotizaciones». Finanzas recibe el perfil «Finanzas».
3. **Configuración del flujo:** marca cada decisión según lo que confirme LPulpo:
   - Servicios y campos del brief.
   - Tareas automáticas.
   - Parámetros comerciales.
4. **Modelos y proveedores:** carga los recursos a mano. Las fotos se referencian con su ruta de Dropbox o un enlace https.

## Comprobar permisos y aislamiento

- **Pruebas automáticas:** `test/productions.spec.ts` cubre que otra empresa no ve ni toca nada (aunque envíe el `companyId`), que consulta solo lee y que aprobar exige su perfil.
- **Prueba manual:** con un usuario de consulta, la ficha no muestra botones de estado ni de edición.

## Integraciones (cuando haya accesos)

- **WhatsApp:**
  1. Registrar la línea en Canales e integraciones.
  2. Configurar `META_APP_SECRET` y `META_VERIFY_TOKEN`.
  3. Validar con «Validar configuración (sin enviar nada)».
  4. Probar con un número de pruebas antes del número real.
- **Meta Ads:** cuenta en solo lectura con un token `ads_read` (Publicidad → Cuentas). Para el piloto no se pausa, crea ni cambia nada.
- **Google Calendar:** ver `docs/google-calendar.md`.
- **Dropbox:** no implementado. El diseño es un inventario de solo lectura con revisión humana.

## Apagar

```bash
mongosh --port 27019 --eval 'db.getSiblingDB("admin").shutdownServer()'
```

La API y el web del piloto se detienen cerrando sus procesos (puertos 4011 y 5180).
