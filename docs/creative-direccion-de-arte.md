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

## 6. Auditoría visual con el laboratorio (oct-2026)

**Cómo se hizo.** `apps/api/scripts/creative-lab.ts` genera piezas para 7 marcas **ficticias** (dos cafeterías con estilos opuestos, cosmética premium, gimnasio, consultoría, juguetería, nutrición) y 6 intenciones (promoción, producto, consejo, testimonio, catálogo, presentación de servicio). Usa las mismas funciones que el endpoint de propuestas.

En total son 217 piezas: las propuestas en IG cuadrado y la principal adaptada a IG vertical, Historias y Facebook. La página `/lab/creative` (solo en desarrollo, no entra al build) las dibuja con el **mismo renderizador que la exportación del editor** (`DocRender.tsx`, ahora compartido por editor, vista previa y laboratorio), las exporta al tamaño exacto y mide la altura real de cada texto. Las fotos son imágenes de prueba dibujadas y marcadas «IMAGEN DE PRUEBA».

Para volver a correrlo:
- `npx ts-node --transpile-only scripts/creative-lab.ts <carpeta>`;
- abrir `/lab/creative` con el ayudante local que sirve `cases.json` y guarda los PNG.

Los resultados quedan en `docs/creative-lab/{antes,despues}`: `informe.md`, `findings.json`, `measured.json`, `hojas/` y `comparacion/`.

**Similitud estructural** (`common/creative/similarity.ts`): huella en una retícula de 12×12 por función (foto, titular, texto, precio, botón, logo, bloques), más la proporción foto/texto, la escala del titular y la posición del logo y del botón. Ignora colores, textos y fuentes. A partir de 0,8 se considera la misma estructura, es decir, un cambio solo cosmético.

### Hallazgos (antes)

1. **La marca casi no cambiaba la estructura dentro de una familia.** Testimonio e Informativo salían idénticos (similitud 1,0) entre marcas muy distintas: 23 pares de marcas distintas con la misma estructura.
2. **Contenido perdido en silencio.** Editorial no mostraba los puntos que escribió la persona.
3. **La promoción de Café Aurora quedó en foto protagonista con el «2x1» del tamaño del texto de apoyo.**
4. **Énfasis del titular dominante mal partido:** «…de la / **tarde**», «…20 % / **menos**».
5. **Catálogo de 3 productos en 2 columnas:** celda vacía, tarjetas apaisadas, nombres diminutos.
6. **Testimonio en Historias y Facebook:** contenido arriba y la mitad del lienzo vacía.
7. **Fotos de producto del catálogo (Pedidos/Menú) desconectadas de Creative.**
8. **La medición del servidor sobrestimaba líneas** (Lora 17/116, Montserrat 13/52), lo que dejaba huecos entre bloques.
9. **Defectos del motor:**
   - la lógica para resignar contenido se detenía ante un rol ausente;
   - el control de calidad trataba `#FF3D00` como transparente;
   - el logo exactamente en el borde de la zona segura contaba como invasión (redondeo);
   - la vista previa de propuestas no dibujaba subrayados ni bordes de elipses (no era fiel a la exportación).

### Mejoras implementadas

- **Estructuras según el carácter de la marca** (`Mood`: refinada, enérgica, cálida o clara) en oferta (4 estructuras), testimonio (4), consejo (4) e informativo (3). Si un carácter admite varias, la semilla de la empresa elige una, y las composiciones partidas pueden ir en espejo. Al pedir «otras variantes» se recorren las siguientes estructuras.
- **Repetición medida por estructura:** si la estructura preferida repite una pieza reciente, se elige otra de la misma familia. Además, el aviso REPETITION se calcula por distribución y no por el nombre de la familia.
- **Cobertura de contenido:** cada familia declara qué campos muestra. Lo central para el objetivo que una familia no mostraría se penaliza y se informa. Editorial ahora muestra los puntos.
- **Promociones:** sello de precio en la foto protagonista; oferta con el precio como protagonista para marcas enérgicas; precio con peso en la oferta refinada.
- **Énfasis:** va sobre la oferta («2x1», «20 % menos», «gratis», «sin costo»). Nunca deja preposiciones colgando.
- **Catálogo:** retícula según la cantidad de productos, tarjetas a la medida de su contenido, fotos del catálogo. Con `GET /creative/catalog-products` y `POST /creative/assets/from-product` (copia, no referencia), el asistente trae la foto del producto.
- **Texto:**
  - medición calibrada con la altura real;
  - incluye el espaciado de letras de las mayúsculas y el ancho de los dígitos;
  - nunca se parte una palabra a la mitad;
  - el precio del sello queda en una línea.
- **Composición:** en formatos altos, los bloques que quedaban arriba con mucho vacío debajo se reequilibran. En Editorial, la foto cede alto según la cantidad de texto.
- **Nuevos avisos** (heurísticos, nivel INFO): espacio vacío, jerarquía débil, precio poco visible.

### Resultados medidos (antes → después, mismas marcas y contenidos)

| Métrica | Antes | Después |
| --- | --- | --- |
| Pares de marcas distintas con la misma estructura (≥ 0,8) | 23 | 10 |
| Café Aurora vs Granos & Co (mismo rubro), Informativo | 0,78 | 0,38 |
| Café Aurora vs Granos & Co, Testimonio | 0,55 | 0,54 |
| Café Aurora vs Granos & Co, Promoción | 0,28 | 0,15 |
| Textos donde el render real tiene MÁS líneas que lo estimado (riesgo de encimado) | 0 | 0 |
| Texto real fuera del lienzo | 0 | 0 |
| Avisos bloqueantes | 0 | 0 |

### Limitaciones que siguen

- **Más marcas que estructuras:** con 3 estructuras de informativo y 7 marcas, algunas comparten distribución por fuerza (Aurora, Vértice y Raíz usan las barras). Se mitiga con espejo y desempate por empresa. No se agregaron familias solo para aparentar variedad.
- Las cafeterías del laboratorio coinciden en «Consejo» con similitud 0,61: misma estructura de banda, distinta en fondo y logo.
- Las medidas de los avisos de calidad son de este motor y de estas reglas. Ninguna puntuación estética implica mejor conversión.
- Las fotos de prueba son sintéticas. El tratamiento y el encuadre con fotos reales de productos se verificaron solo con dimensiones simuladas.
