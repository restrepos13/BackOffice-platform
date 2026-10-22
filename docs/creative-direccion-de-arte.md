# BackOffice Creative · Dirección de arte

## 1. Auditoría (estado antes de este trabajo)

| Tema | Cómo estaba |
| --- | --- |
| Editor | Konva / react-konva con capas, transformaciones, bloqueo y ocultar, duplicar, deshacer y rehacer, autoguardado con versión esperada (409 si hay conflicto), borrador local, 30 versiones restaurables. |
| Documento | `common/design-doc.ts`. Esquema cerrado v1 con 5 tipos (`text`, `image`, `rect`, `ellipse`, `line`), fuentes de una lista OFL, colores hex, hasta 150 elementos y 6 roles. Se valida en el servidor y se verifica que las imágenes sean de la empresa. |
| Plantillas | `common/creative-templates.ts`: 6 plantillas, cada una con **un solo** diseño, a las que solo se les cambiaban los colores, las fuentes y el logo. |
| Marca | `BrandProfile`: colores, fuentes, logos, tono, público, productos, ofertas, restricciones y protección. Sin identidad visual estructurada. |
| Exportación | Se renderiza en el navegador al tamaño exacto, se sube y el servidor valida el tipo y las medidas. |
| Adaptación | En el navegador, **escalando posiciones**: amontonaba o dejaba huecos. |
| Pruebas | Validación del documento, plantillas, versiones, créditos, aislamiento. |

**Limitaciones del documento** (siguen existiendo; se resuelven con lo que hay):

- No hay degradados, máscaras, sombras, fondos de texto, estilos mezclados dentro de un texto ni alineación vertical.
- Para la legibilidad sobre una foto se usa un rectángulo semitransparente («velo» o «banda»).
- Los recortes circulares se hacen con el radio de la imagen.
- El énfasis de un titular es un segundo texto.

## 2. Qué se agregó (compatible con lo anterior)

- **Esquema (aditivo, misma `schemaVersion`):**
  - 14 roles nuevos (`kicker`, `price`, `badge`, `validity`, `date`, `place`, `quote`, `author`, `item-name`, `item-price`, `item-photo`, `point`, `decoration`, `overlay`);
  - `slot` opcional en cada elemento;
  - `BrandProfile.visualJson` y `CreativeDesign.compositionJson`, ambos opcionales;
  - el modelo `CreativeEvent`.
  
  Los documentos guardados antes siguen siendo válidos y se prueba.
- **Identidad visual** (`common/creative/identity.ts`): posicionamiento, personalidad (hasta 3), estilo de foto, densidad, alineación, ubicación del logo, roles de color, referencias propias y elementos prohibidos.
  - Cada valor dice su procedencia: **confirmado**, **sugerido** (por el rubro y el tono, sin contar lo que está negado, como «nunca técnico») o **por defecto**.
  - Las sugerencias no se guardan solas.
- **12 familias de composición** (`compose.ts` y `art-direction.ts`): fotografía protagonista, editorial minimalista, titular dominante, catálogo, oferta, beneficios, testimonio, consejo, paso a paso, evento, modular e informativo corporativo.
  - Cada una tiene propósito, requisitos (foto, productos, puntos, precio, fecha, cita), afinidad con la personalidad y variantes **estructurales**.
- **Motor de composición:**
  - Tokens de estilo por marca: márgenes según la densidad, tipografía de títulos y textos, mayúsculas solo en marcas enérgicas o con fuentes condensadas, esquinas redondeadas o rectas, motivo decorativo (líneas, bloques, formas orgánicas, franjas o puntos), alineación y zonas seguras.
  - La semilla de la empresa solo desempata entre opciones compatibles con su identidad.
  - Ajusta el tamaño del texto a su caja con una medición estimada.
  - Elige los colores de texto **por contraste** (WCAG).
  - Si algo no entra, resigna primero el contenido secundario y **lo informa**. Nunca deja texto fuera del lienzo.
  - El resultado es un documento editable normal.
- **Selección explicable:** el puntaje combina el ajuste al objetivo, la personalidad, el estilo de foto, las fotos disponibles, las prohibiciones y el uso reciente.
  - Devuelve hasta 3 propuestas de **familias distintas**. Si solo una encaja, devuelve una y lo explica.
  - La «consistencia de campaña» mantiene la estructura a propósito.
  - La semilla es reproducible.
- **Control de calidad** (`quality.ts`), sin modificar nunca el documento:

  | Nivel | Comprobaciones |
  | --- | --- |
  | **Bloquea** | Texto cortado por el borde; imágenes de otra empresa |
  | **Avisa** | Desborde (con la medición real del editor cuando se exporta), textos encimados, contraste WCAG, letra pequeña (heurística), logo ausente o distinto, resolución insuficiente, precios o descuentos no confirmados, zonas tapadas en historias (guía de la comunidad: 250 px arriba y 320 px abajo, no es oficial de Meta) |
  | **Informa** | Repetición de estructura, texto sobre foto (contraste no medible) |

  Cada aviso dice si está medido o estimado.
- **Adaptación** (`adapt.ts`, en el servidor): si el diseño tiene dirección de arte, se **recompone** la misma familia para el nuevo formato con los textos y fotos actuales (leídos por rol y slot, incluidas las ediciones). Si es un diseño anterior, se escala y el control de calidad avisa. Siempre crea una copia: el original no cambia.
- **Interfaz:**
  - Nuevo diseño: objetivo, luego lo mínimo (producto del catálogo con su precio confirmado y fotos propias), luego propuestas con vista previa fiel y su porqué, y de ahí al editor. Sigue existiendo «Empezar en blanco».
  - Editor: «Revisar y exportar» muestra la imagen exacta del archivo y los avisos; lo bloqueante impide descargar y pasar al calendario.
  - Marca: tarjeta «Estilo visual».
- **Medición** (`CreativeEvent`, sin datos personales): composición sugerida, elegida y rechazada; primer cambio manual; revisión con avisos (solo conteos y códigos); exportación; variante usada en el calendario.
  - `GET /creative/art/stats` resume el uso por familia.
  - No mide ventas: no hay un vínculo fiable entre diseño y resultado publicitario.

## 3. IA futura (no implementada)

`common/creative/ai-hooks.ts` define los contratos `VisualAssetGenerator`, `PhotoSelector`, `CompositionEvaluator`, `VariantProposer` y `PerformanceAdvisor`. Todos son `null` hoy.

Cuando se implementen:

- pasan por el libro de créditos (`ai/creative-assist.ts`);
- sus salidas se validan como cualquier documento o recurso;
- nunca se saltan la confirmación de la persona.

## 4. Pruebas

`apps/api/test/creative-art.spec.ts` (59). La prueba principal compone **las 12 familias × 4 formatos × 3 identidades distintas** y exige un documento válido, sin texto cortado, sin textos encimados y sin contraste insuficiente.

También cubre:

- que cambiar solo la paleta **no** cambia la estructura y cambiar la identidad sí;
- que las 12 estructuras son distintas;
- que dos empresas del mismo rubro reciben direcciones distintas;
- la diversidad y la consistencia de campaña;
- la reproducibilidad;
- los avisos de calidad;
- que la adaptación conserva las ediciones;
- que los diseños anteriores siguen funcionando;
- el aislamiento entre empresas (fotos, adaptación, revisión, eventos, referencias).

## 5. Pendiente o limitado

- La medición de texto en el servidor es una estimación. Al exportar manda la medición real del navegador.
- No hay degradados, máscaras ni sombras (requieren ampliar el esquema y el editor).
- La foto de cada producto del catálogo todavía no se elige en el asistente: las tarjetas usan bloques de color.
- No hay un vínculo fiable entre una pieza y sus resultados publicitarios, por eso no se recomienda «lo que vende más».
- Al desplegar: `npx prisma db push --skip-generate` (agrega campos opcionales y el modelo `CreativeEvent`; no es destructivo).
