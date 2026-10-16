# Resultados de pruebas

## Actualización 16 oct 2026 (rama `agentes-domicilios`, integrada a `main`)

| Suite | Resultado |
|---|---|
| Jest (unitarias + integración + seguridad) | **304/304 en verde** |
| E2E en simultáneo empresa + devs contra el API vivo (`test/e2e-growth.mjs`) | **52/52**, dos corridas seguidas |
| E2E de seguridad (`test/e2e-security.mjs`) | **42/42** |
| Typecheck + build producción (api y web) | Limpios |

Bugs reales que encontraron las pruebas y quedaron corregidos: pedidos externos
duplicados con reintentos simultáneos (candado único), hash de API keys expuesto en
el listado, datos huérfanos al borrar una empresa, modales recortados por la
animación de página, hora de programación mostrada en UTC.

---

# Resultados de pruebas — sesión nocturna (23–24 sep 2026)

Todo lo de esta sesión quedó **integrado en `main`** (commit de integración
`338a8cb`), compilado en modo producción y corriendo en este Mac
(API :4001 + web :5173 + túnel ngrok). No hay remoto ni hosting externo
configurado — "producción" = el build final corriendo local, como quedó
acordado.

## Resumen ejecutivo

| Suite | Resultado |
|---|---|
| Jest (unitarias + integración + seguridad) | **145/145 en verde** (8 suites) |
| E2E de seguridad contra el API VIVO | **42/42 en verde** |
| Carga (600 req · 60 concurrentes) | **600 OK · 0 errores 5xx · 0 caídas** |
| Carga agresiva (2000 req · 150 concurrentes) | **1600 OK + 400 throttled (429 por diseño) · 0 errores 5xx** |
| Typecheck + build producción (api y web) | Limpios |

## Qué se construyó esta noche

### Fase 7 — Seguridad y salida a producción ✅
- **Ataques multi-tenant por cada endpoint** (Jest + 42 checks HTTP reales):
  leer/editar/borrar pedidos, ítems, catálogo, clientes, conversaciones,
  archivos, reportes y empresas ajenas → 403/404 SIEMPRE; los listados
  escopan en silencio; crear "para" otra empresa cae en la propia.
- **Fuga real encontrada y corregida por el E2E**: `GET /integrations`
  exponía el `configJson` crudo con el token cifrado de Twilio. Ya no sale
  ni cifrado.
- **Mínimo privilegio del rol de área**: antes podía listar pedidos completos
  y catálogo; ahora solo entra a su vista, marcar listo y su cuenta (403 en
  todo lo demás, incluido el stream SSE).
- **Login endurecido**: bloqueo por cuenta (5 fallos → 15 min, auditado),
  anti-enumeración real (bcrypt corre siempre contra hash señuelo; mismo
  mensaje exista o no la cuenta, bloqueada o desactivada), política de
  contraseña en el servidor, rate limit por IP verificado (429).
- **Integración del flujo completo** (Jest): mensaje → borrador → confirmación
  → distribución → recordatorios → producción → entrega → feedback; webhook
  duplicado; conversaciones difíciles (cambio a mitad, arrepentido,
  contradicción → escala, fuera de horario → bloqueado); **fallos simulados**
  (DeepInfra caído → escala sin perder la conversación; Twilio sin plantilla
  → 3 intentos → FALLIDO con auditoría); **idempotencia** del job de
  recordatorios corriendo dos veces EN PARALELO.
- **Observabilidad**: `GET /reports/ops-health` (global para plataforma):
  recordatorios fallidos, mensajes no entregados, escalamientos vs promedio
  (detección de anomalía), feedback negativo.
- **Checklist de salida**: `LANZAMIENTO.md` — 7 secciones a marcar antes de
  conectar el número real de cualquier empresa.

### Aprovisionamiento sin código ✅
- **Plantillas de vertical** en el wizard (paso 1 "Plantilla"):
  - *Catering / pedidos programados*: TODO el paquete Nexus (módulo de
    pedidos, agenda con cortes y franjas, 4 áreas, bot con personalidad,
    línea Twilio en sandbox).
  - *Estudio webcam*: modo chatter + galería PPV.
  - *Servicios con citas*: recepcionista IA + agenda.
- **Clonar una empresa existente**: copia módulos, agenda, catálogo (áreas
  remapeadas), bots y líneas — JAMÁS credenciales, llaves ni datos de
  clientes; las líneas clonadas nacen en sandbox forzado.
- Verificado en vivo: se creó una empresa con plantilla catering y un clon
  de Nexus, se comprobó todo lo creado y se eliminaron.

### Experiencia y funciones por rol ✅
- **Tour de bienvenida** una sola vez por usuario (persistido en la base,
  funciona en cualquier dispositivo): pasos por rol (plataforma 4, empresa 6,
  área 2), resalta cada sección del panel, se salta con un click y omite
  módulos no contratados. Verificado: aparece, se recorre, NO reaparece.
- **Transiciones** de página y modales pulidas (respetan
  `prefers-reduced-motion`); barrida **responsive** en 375px sin scroll
  horizontal (wizard, reportes, marketing, bandeja).
- **Pedidos manuales** (admins): pedidos por teléfono/presenciales desde el
  panel con el MISMO pipeline que la IA — verificado en vivo: pedido creado
  → confirmado → programado con área y recordatorios, autor HUMANO trazado.
- **Notificaciones en vivo** en toda la app (SSE): atención humana requerida,
  feedback de cliente recibido y reporte diario listo, con botón de acción.
- **PDFs con la identidad de cada marca** (color, cabecera, pie): orden de
  pedido (ítems por área + trazabilidad) y reporte diario (KPIs + precisión
  IA + alertas). Verificados visualmente. **Correos del sistema** ahora salen
  con el layout de la marca de cada empresa.

### Marketing (cascarón, extra por empresa) ✅
- Módulo activable `marketing`: campañas (canales, fechas, presupuesto) y
  piezas de contenido (reels/posts/historias/anuncios) con estados y
  calendario.
- **Copy, hashtags y guion generados con la IA de la propia empresa** (BYOK,
  consumo registrado en su panel).
- **Gancho a MoneyPrinterTurbo listo** (revisé el repo del proyecto 5): al
  configurar `MPT_BASE_URL`/`MPT_API_KEY` en Dev Tools, el botón "Generar
  video del reel" encola la tarea (guion como narración, vertical 9:16) y el
  sistema trae el progreso y el video final solo. Sin configurar, explica
  exactamente qué falta. Activado en Nexus.

## Pruebas de carga (detalle)

- **600 peticiones, 60 concurrentes** (8 endpoints mezclados): 600 OK,
  0 errores, p50 1.3 s / p95 4.9 s (la latencia la domina Atlas en la nube
  con esa concurrencia), API vivo al terminar.
- **2000 peticiones, 150 concurrentes**: 1600 OK + 400 con `429` — el rate
  limit respondió exactamente como está diseñado (proteger, no caerse):
  **cero errores 5xx, cero caídas de proceso**.

## Cómo repetir las pruebas

```bash
pnpm --filter @backoffice/api test        # 145 pruebas Jest
node apps/api/test/e2e-security.mjs       # 42 checks contra el API vivo
node apps/api/test/load-test.mjs 600 60   # carga (total / concurrencia)
```

## Pendientes que NO dependen de código

1. Llave DeepInfra real de Nexus (motor y consulta en vivo).
2. Credenciales Twilio reales de Nexus → checklist `LANZAMIENTO.md` → quitar sandbox.
3. SMTP real (correos), llaves Wompi reales, callback OAuth de Meta, Stripe.
4. Para reels con IA: levantar MoneyPrinterTurbo (proyecto 5) y poner
   `MPT_BASE_URL` en Dev Tools → Settings.
5. Hosting 24/7 fuera del Mac + rotar la contraseña de Atlas.
