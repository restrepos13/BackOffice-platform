# Incorporación de empresas: perfil, complejidad y productos (Fase 1)

Estado al 22-oct-2026, en local y sin desplegar. El código manda:
- Modelo: `apps/api/src/common/setup-profile.ts`.
- Flujos: `apps/api/src/modules/signup.module.ts` y `CompaniesService.provision()`.
- Pantallas: `apps/web/src/components/setup/SetupEditor.tsx`.

## Tres conceptos separados

| Concepto | Qué es | Dónde vive |
|---|---|---|
| Perfil de negocio | Sector (`ProfileKey`: ROPA, COMIDA, RESERVAS, SALUD…) y actividad concreta | `setup.business` |
| Complejidad operativa | SIMPLE, INTERMEDIATE o COMPLEX, calculada con señales de cómo trabaja | `setup.complexity` |
| Productos | Automation, Creative, Ads Intelligence, cada uno por separado | `Company.productsJson` + `setup.products` |

**Complejidad.** Se calcula en `computeComplexity` y es independiente del sector. Cada señal suma 0, 1 o 2 puntos:
- Etapas: 3-4 → 1; 5 o más → 2.
- Personas: 3-10 → 1; más de 10 → 2.
- Dependencias entre áreas: 1-2 traspasos → 1; 3 o más → 2.
- Aprobaciones humanas: 1 → 1; 2 o más → 2.
- Sistemas externos: 1-2 → 1; 3 o más → 2.
- Volumen diario: 30-100 → 1; más de 100 → 2.
- Procesos internos o coordinación entre áreas: +1 cada uno.

Con 0-2 puntos es SIMPLE, con 3-6 INTERMEDIATE y con 7 o más COMPLEX. Papel, cuaderno y los propios canales de chat no cuentan como sistemas. El administrador puede ajustar el nivel, siempre con un motivo. El cliente no puede ajustarlo; se recalcula con sus respuestas.

**Capacidades** (`CAPABILITIES`). Salen de las necesidades y señales. Cada una tiene su estado real:
- **Disponible:** atención por WhatsApp con IA, pedidos, domicilios, producción por áreas, reservas por el chat (desde la Fase 2, ver [reservas.md](reservas.md)), embudo y seguimiento, reporte a gerencia, contenido (Creative) y publicidad (Ads; Meta).
- **En parte:** recordatorios (fuera de la ventana de 24 h necesitan la plantilla `recordatorio_reserva`) e integraciones.
- **Próxima fase:** procesos internos de varias etapas y aprobaciones configurables. Se registran, pero no se ejecutan.

**Productos recomendados.** Son los productos de las capacidades detectadas, cada uno con sus razones. La persona elige; si no se detecta nada, se recomienda Automation.

## Autoservicio (`/registro`)

1. **Entrevista.**
   - Las dos primeras preguntas son fijas.
   - Después la IA pregunta solo lo que falta. Ahora también cubre: tareas a mano y las que más tiempo quitan, personas, etapas y sistemas, qué debe aprobar una persona, y si necesita contenido o publicidad. El prompt le pide no volverlo un cuestionario en negocios sencillos.
   - Sigue el tope de 8 respuestas.
   - Sin IA, el motor por código pregunta en este orden lo que no sabe: oferta, entrega o citas, tareas, equipo, contenido/publicidad, pagos…
2. **Plano.**
   - La IA devuelve además `operacion`.
   - `setupFromConversation` lo combina con la lectura por código (`readOperation`) y arma el perfil.
   - Las herramientas del plano se alinean con las capacidades (`alignModules`). Por ejemplo, una cancha no recibe pedidos, menú, producción ni domicilios.
3. **Revisión.** La sección "Lo que necesitas" deja corregir respuestas y elegir productos.
   - Cada cambio se recalcula en el servidor (`POST /public/setup/evaluate`).
   - Sin Automation se ocultan el asistente, las herramientas, el embudo y las respuestas rápidas.
4. **Crear cuenta.**
   - El servidor valida y recalcula el perfil.
   - `provision()` recibe `products` y `setup`.
   - Sin Automation no se crean asistente, línea de WhatsApp, embudo, respuestas rápidas ni seguimientos.

## Configuración asistida (Plataforma)

- **Nueva empresa:** el primer paso es "Perfil y productos".
  - El administrador pega las notas de la reunión. `POST /platform/setup/propose` arma la misma propuesta que el autoservicio, con IA o con el motor por código.
  - O empieza en blanco.
  - Edita el perfil con el mismo editor (modo admin, con ajuste de complejidad y motivo) y elige productos.
  - Puede crear también lo propuesto: catálogo, horario, preguntas, embudo y respuestas rápidas.
  - Las herramientas que elige el administrador mandan; solo se suman las que piden las capacidades.
- **Empresa existente** (ficha → "Perfil del negocio"):
  - `GET/PUT /platform/companies/:id/setup`.
  - Las empresas anteriores parten de lo que contaron en su registro.
  - Se puede ligar a una `AgentCall` de esa empresa; se valida que sea suya.
  - Guardar cambia los productos a los elegidos y suma herramientas, sin quitar ninguna.
  - No hay integración con Meet ni Calendar: el enlace de la llamada lo sigue pegando el equipo.

Las dos modalidades guardan `onboardingJson.setup` con la misma estructura (`version`, `source` SELF_SERVICE o ASSISTED, …) y `productsJson` con el mismo formato. Hay una prueba que lo verifica.

## Productos y seguridad

- **Empresa nueva:** recibe exactamente los productos elegidos (`initialProducts`, explícitos desde el día uno).
  - Activar un plan después ya no agrega Creative ni Ads.
  - Un registro de un cliente viejo, sin perfil, queda con productos explícitos según lo que contó; por defecto, Automation.
- **Validación en el servidor:** `validateProducts` exige al menos uno, solo claves válidas y sin duplicados. Nada del navegador se usa sin validar.
- **Acceso:** el guard (`ProductsGuard`) y `RequireProduct` siguen exigiendo el producto en cada endpoint y pantalla.
- **Empresas existentes con `productsJson` vacío:** siguen con la regla anterior (Automation siempre; Creative y Ads con plan) y su lista de "Primeros pasos" de siempre. Pasan a la elección explícita cuando plataforma les define el perfil o los productos.

## Persistencia y compatibilidad

- `onboardingJson` solo **agrega** la clave `setup`. Se revisaron sus consumidores (ai-cost, checkout, creative, opportunities, signup) y ninguno cambia.
- `setupOf()` devuelve null para empresas anteriores o datos dañados.
- No hay migración de datos ni cambios de esquema en esta fase.

## Provisión sin huérfanos

- **Antes de crear nada** se valida: correo del administrador (formato y que no exista), personalidad, productos y perfil.
- **Si algo falla después de crear** (en `provision` o en el registro), `discardProvisioned` borra empresa, usuarios y datos sueltos.

## Pruebas

| Archivo | Cubre |
|---|---|
| `apps/api/test/onboarding-setup.spec.ts` (23) | Combinaciones de productos; reservas simple; catering complejo; misma estructura en ambas modalidades; ajuste del administrador; acceso directo bloqueado; compatibilidad; validación y rollback |
| `apps/web/src/components/setup/SetupEditor.test.tsx` (4) | El editor |
| `blueprint-engine.spec.ts` | Actualizado al nuevo orden de preguntas sin IA |

## Pendiente y preparado para la próxima fase

**Preparado, no implementado:**
- **Capacidades** `PROCESOS` y `APROBACIONES` (estado próxima fase):
  - El perfil ya guarda etapas, personas, áreas, aprobaciones y sistemas.
  - El motor de procesos podrá leerlos de `onboardingJson.setup`.
- **`AGENDA` y `RECORDATORIOS`** (estado en parte):
  - Faltan la herramienta del agente para reservar con disponibilidad y los recordatorios por reserva.
  - Hoy el preset de un negocio de reservas es `solo_consultas`.

**Decisiones comerciales pendientes:**
- Precio y cobro por producto: la facturación sigue con plan + complementos.
- Si un producto elegido en el autoservicio debe quedar activo antes de pagar. Hoy queda activo mientras la empresa está en configuración, igual que pasaba con Automation.
- Si los planes deben ligarse a productos.
