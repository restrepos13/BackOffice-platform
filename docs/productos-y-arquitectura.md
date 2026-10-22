# BackOffice en tres productos: Automation, Creative y Ads Intelligence

Estado al 22-oct-2026. El código manda sobre este documento. Lo implementado aquí
está en local, sin desplegar.

## 1. Auditoría (qué había antes de este cambio)

### Arquitectura
- Monolito NestJS + Prisma (MongoDB Atlas) y panel React/Vite. No se justifica
  pasar a microservicios: los tres productos comparten empresa, usuarios, IA,
  archivos y auditoría, y el volumen actual lo atiende un proceso.
- La empresa siempre sale de la sesión (`JwtAuthGuard` → `req.user.companyId`).
  Plataforma (SUPER_ADMIN/DEV) puede indicar `companyId`. Cada servicio tiene su
  propio `companyOf()`.
- Guards globales: Throttler, JWT y roles (COMPANY_AREA y COMPANY_COURIER con
  mínimo privilegio).
- Qué ve cada empresa:
  - `Company.modulesJson`: secciones por rubro, como pedidos, domicilios, agenda o marketing.
  - `Company.addonsJson`: complementos.
  - Un plan (`planId`), que habilitaba Creative y Publicidad.

### Hallazgo principal
Los módulos solo se ocultaban en el menú. El servidor no los exigía: una empresa
podía llamar a cualquier endpoint de otro "módulo" conociendo la URL. La única
barrera de servidor era "tener plan" en Creative, Publicidad y el Radar.

### Magic Layers
No existe en el repositorio: no aparece ni en el código ni en la documentación. Lo que sí existe y
sirve como base para reconstruir diseños:

| Pieza | Qué hace | Reutilizable para importar/reconstruir |
|---|---|---|
| `common/design-doc.ts` | Documento por capas validado y versionado (texto, imagen, formas), con roles y slots | Sí: es el formato destino |
| `common/creative/compose.ts` | Arma documentos editables desde contenido + familia + estilo | Sí: rearmar con la identidad de la marca |
| `common/creative/adapt.ts` | Adapta a otro formato recomponiendo por roles | Sí |
| `common/creative/quality.ts`, `similarity.ts`, `text-fit.ts` | Calidad, huella estructural y medición de texto | Sí |
| `pages/company/creative/{Editor,DocRender}.tsx` | Editor Konva y renderizador compartido | Sí |

Lo que NO existe:
- Importar PSD, PDF, SVG o un diseño de Canva/Figma. Solo se suben imágenes PNG, JPG o WEBP.
- Separar una imagen plana en capas (segmentación).
- Recuperar texto editable (OCR).
- Detectar fondos u objetos.

Reconstruir diseños necesita un modelo de visión (OCR + segmentación). Es un
proveedor nuevo con costo, y es una decisión pendiente: los ganchos de IA están
en `common/creative/ai-hooks.ts` y hoy devuelven null.

### Matriz de funcionalidades

| Funcionalidad | Módulo actual | Producto objetivo | Estado real | Acción |
|---|---|---|---|---|
| Bandeja WhatsApp (Meta Cloud API y Twilio) + motor IA con paso a humano | conversations, engine, webhooks, twilio | Automation | Implementado y probado | Conservado; el motor no atiende si Automation está inactivo (pasa a humano) |
| Instagram y Messenger (entrada) | webhooks `/meta` | Automation | Implementado; depende de permisos de la app de Meta | Conservado |
| Contactos, embudos, agenda, seguimientos | contacts, pipelines, ops | Automation | Implementado | Exigido en servidor |
| Pedidos, áreas, domicilios, pedidos externos, DIAN | orders, catalog, delivery, inbound-orders | Automation | Implementado (DIAN depende del proveedor de la empresa) | Exigido en servidor; el catálogo queda común |
| Campañas WhatsApp, reactivación, cobranza, auditor | campaigns, addons | Automation | Implementado | Exigido en servidor; sus crons saltan empresas sin Automation |
| Asistentes, personalidades, conocimiento, automatizaciones, integraciones, galería | bots, personas, knowledge, automations, integrations, media | Automation | Implementado | Exigido en servidor |
| Gerencia, analítica, costos de IA, arma tu negocio con IA | reports, metrics, ai-cost, ai-setup | Automation | Implementado | Exigido en servidor |
| Identidad visual, editor por capas, dirección de arte, calidad, adaptación, exportación | creative | Creative | Implementado y probado | Exigido en servidor |
| Calendario y publicación orgánica | creative, social, marketing | Creative | Implementado; publicar requiere Meta aprobado | Exigido; el cron no publica si Creative está inactivo |
| Créditos de Creative | creative-credits | Creative | Libro de créditos real; sin generación IA conectada | Conservado |
| Render de video (marketing) | marketing | Creative | Parcial | Conservado |
| Meta Ads: cuentas, sync, insights, pausar/reanudar, crear campaña en pausa | ads + common/ads | Ads | Implementado; pendiente de App Review de Meta | Exigido; el cron no sincroniza si Ads está inactivo |
| Google Ads, TikTok Ads | common/ads/registry | Ads | Solo contrato (`PendingProvider`) | Sin cambios: no se marcan como funcionales |
| Datos DEMO de publicidad | demo-provider | Ads | Simulado y etiquetado | Conservado |
| Autopilot | common/ads/autopilot | Ads | Implementado, solo pausa, con topes y aprobación | Conservado |
| Atribución de ingresos | common/ads/revenue | Ads (lee CRM) | Parcial: solo por el ID del anuncio en el referral CTWA | Conservado; sin Automation no hay datos de CRM que atribuir |
| Conversions API | common/ads/conversions | Ads | Payload armado, no se envía | Sin cambios |
| Radar de oportunidades | opportunities | Compartido | Implementado | Fuentes filtradas por producto (ADS ↔ Ads, CRM ↔ Automation) |
| Biblioteca de recursos | BrandAsset (solo Creative) | Compartido | Solo imágenes, solo desde Creative | Extendida: Ads sube imágenes y videos sin Creative |
| Plan, facturación, paquetes IA, equipo, términos, exportación | billing, checkout, plans, ai-credits, users, terms, data-export | Común | Implementado | Sin cambios (sin decorador de producto) |

### Dependencias entre productos
- Creative depende de:
  - Social y marketing para el calendario y la publicación (`ContentPiece`).
  - El catálogo para las fotos de producto.
  - El Radar en su inicio.
- Ads depende del CRM para la atribución y las oportunidades de seguimiento. Sin
  Automation, la atribución queda vacía; no se rompe.
- El Radar mezcla dos fuentes: ADS (sale de Ads) y CRM (sale de Automation).

## 2. Arquitectura objetivo (implementada)

### Productos por empresa
- `Company.productsJson` (opcional): `{ AUTOMATION|CREATIVE|ADS: { enabled, since, until, requestedAt, requestedBy } }`.
- **Compatibilidad:** si está vacío, se usa la regla anterior: Automation siempre, y
  Creative + Ads con cualquier plan. Ninguna empresa existente cambia.
- Cuando plataforma guarda la elección de una empresa, desde ese momento manda lo guardado.
- Apagar un producto no borra datos.
- Lógica en `apps/api/src/common/products.ts`.

### Permisos en el servidor
- Guard global `ProductsGuard` (`auth/products.guard.ts`) con el decorador
  `@Products(...)` por controlador o método. Basta con tener uno de los productos indicados.
- La empresa sale de la sesión. Plataforma no se limita, porque administra todas las empresas.
- Respuesta 403 con `code: PRODUCT_INACTIVE`, `products` y `needsPlan`, más un mensaje claro.
- Caché de 30 s por empresa; se invalida al cambiar los productos.
- Además del guard, los servicios de Creative, Ads, Radar y Biblioteca verifican
  el producto en su `companyOf()` (defensa en profundidad).
- **Procesos automáticos:**
  - Sin Automation: el motor de IA pasa la conversación a una persona, y no corren
    seguimientos, campañas programadas, reactivación, cobranza ni auditor.
  - Sin Creative: no se publica lo programado.
  - Sin Ads: no se sincroniza ni corren reglas.
  - Lo pendiente espera, no se pierde.

### Qué endpoints pertenecen a qué producto
- **Automation:**
  - conversations, contacts, bots, personas, knowledge, automations, pipelines, campaigns
  - addons, ops (citas y seguimientos), orders, reminders, customers, delivery
  - promotions (y respuestas rápidas), media, reports, metrics, engine
  - ai-setup, ai-costs, integrations, inbound-orders
  - pagos de la empresa (`/payments/config`, `/payments/orders/*`)
- **Creative:** creative, social, marketing.
- **Ads:** ads.
- **Creative o Ads:** library.
- **Cualquiera:** opportunities, con filtro de fuente.
- **Comunes:** auth, companies, users, billing, checkout, plans, ai-credits,
  ai-usage, terms, data-export, catálogo, events, products, signup y onboarding.

### Biblioteca compartida (`modules/library.module.ts`)
- Reutiliza `BrandAsset`, sin un segundo almacén. Campos nuevos, todos opcionales:
  `source`, `originModule`, `designId`, `designVersion`, `derivedFromId`, `sha256` y `durationSec`.
- Tipo `VIDEO`.
- Ads sube imágenes (PNG, JPG o WEBP, hasta 8 MB) y videos (MP4 o MOV, hasta 12 MB). Las medidas
  y la duración se leen de los bytes.
- Deduplicación por huella del archivo.
- Un diseño de Creative entra como recurso por versión, con `derivedFromId` hacia la anterior.
  La versión anterior no se toca, así un anuncio nunca cambia en silencio.
- `AdAssetLink` vincula un recurso con una campaña, conjunto o anuncio.
  Mientras exista el vínculo, el recurso no se borra (tampoco desde Creative).
  Es un registro interno: NO sube nada a Meta.
- Creative sigue viendo solo imágenes en su editor.

### Navegación
- El menú se agrupa en Automation, Creative, Ads Intelligence, Recursos (Biblioteca)
  y Cuenta. Los productos no activos aparecen como "Otros productos".
- Rutas protegidas con `RequireProduct`.
- `/app` lleva al primer producto activo si la empresa no tiene Automation.
- `/app/producto/:key` explica qué incluye un producto y permite pedirlo (lo pide un administrador).
- Plataforma:
  - Interruptores por producto en la ficha de la empresa.
  - Solicitudes pendientes en Empresas.

### Endpoints nuevos
- `GET /products`
- `POST /products/:key/request`
- `GET|PUT /platform/companies/:id/products`
- `GET /platform/product-requests`
- `GET|POST /library/assets`
- `GET|PATCH|DELETE /library/assets/:id`
- `GET /library/assets/:id/file`
- `GET /library/ad-entities`
- `POST|DELETE /library/assets/:id/links[/:linkId]`
- `POST /library/from-design/:designId`

## 3. Migración

- No hay migración de datos. Todos los campos nuevos son opcionales (en Mongo, un
  campo requerido ausente rompe la lectura en Prisma), y `null` equivale al comportamiento anterior.
- Hace falta `prisma db push` en producción solo para los índices nuevos:
  - `AdAssetLink`: único `assetId+adEntityId`, más los índices por empresa.
  - `BrandAsset`: `companyId+sha256`.

  Es aditivo. Sin el push la aplicación funciona igual: la duplicidad del vínculo
  también se controla en código.
- **Reversión:** el código anterior ignora `productsJson` y los campos nuevos.
- No hay variables de entorno nuevas.

## 4. Validación

- API: 560 tests en verde.
  - Los 538 anteriores siguen pasando sin cambios. Las empresas anteriores sin plan
    siguen recibiendo el mismo aviso de "elige un plan".
  - 22 nuevos en `test/products.spec.ts`:
    - Resolución de productos y compatibilidad.
    - Guard con los decoradores reales.
    - Cobertura de decoradores por controlador.
    - Solicitudes y activación.
    - Ads sin Creative: sube imágenes y videos, deduplica, vincula y bloquea el borrado.
    - Creative sin Ads.
    - Automation sin los otros.
    - Aislamiento entre empresas en la biblioteca y el Radar, también manipulando ids y `companyId`.
    - Versiones de diseños.
- Typecheck de API y web, `nest build` y `vite build` en verde. El repositorio no tiene linter configurado.
- Verificado en el navegador:
  - El menú por producto.
  - La biblioteca y su detalle.
  - La pantalla de producto inactivo con el 403 del servidor. Se apagó Ads un momento en la
    empresa demo y se restauró.
  - El botón "A la biblioteca" del editor.

## 5. Estado y decisiones pendientes

**Implementado y probado:**
- Productos por empresa con compatibilidad.
- Exigencia en el servidor.
- Crons y motor condicionados al producto.
- Biblioteca compartida con video, versiones, vínculos y bloqueo de borrado.
- Navegación por producto, solicitud de activación y activación desde plataforma.

**Implementado, pendiente de validación externa:**
- Meta Ads real y publicación orgánica (App Review y permisos de Meta).
- Instagram y Messenger.

**Parcial:**
- Atribución (solo CTWA).
- Video de marketing.
- Los vínculos recurso↔anuncio son internos: no suben la creatividad a Meta.

**Diseñado, no implementado:**
- Subir creatividades a Meta (`adimages`/`advideos`) desde la biblioteca.
- Conectores de Drive o Dropbox: no existen; se avisaría cuando un recurso externo deje de estar disponible.
- Google y TikTok Ads (solo contrato).
- Reconstrucción por capas al estilo Magic Layers (ver sección 1).

**Pendiente de decisión:**
- Precios y cobro por producto. Hoy la facturación sigue con plan + complementos y no mira los productos.
- Qué productos recibe una empresa nueva al registrarse. Hoy aplica la regla anterior.
- Almacenamiento de objetos para videos de más de 12 MB. El disco del servidor es
  efímero y la base admite hasta ~12 MB por archivo; cualquier opción es un proveedor nuevo.
- Proveedor de visión para la reconstrucción de diseños.
- Si "Mi negocio" (catálogo, horario, conocimiento) debe estar disponible para
  empresas sin Automation. Hoy está dentro de Automation; el catálogo en el API es común.
