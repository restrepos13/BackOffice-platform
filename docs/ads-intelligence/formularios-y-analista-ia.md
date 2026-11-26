# Ads · Formularios instantáneos y analista con IA

## Formularios instantáneos (Meta Lead Ads)

**Qué hace.** Trae a BackOffice a las personas que llenan el formulario de un
anuncio y crea (o une) el contacto en el CRM con el anuncio, el conjunto y la
campaña de donde vino. Con eso «Leads y ventas» puede decir cuánto costó cada
lead y cuáles terminaron en venta.

**Dos caminos, uno solo necesario.**

| Camino | Cómo llega | Qué necesita |
|---|---|---|
| Importación directa | BackOffice le pregunta a Meta cada 10 minutos, anuncio por anuncio | El acceso de la cuenta publicitaria con `leads_retrieval` |
| Aviso de Meta (webhook `leadgen`) | Meta avisa al instante | La página conectada como integración y suscrita al aviso |

La importación directa es la que funciona desde el primer día: no depende de
suscribir la página. El aviso, si existe, solo adelanta la llegada; ambos caen
en la misma fila (el `_id` sale del `leadgen_id`), así que nunca se duplica.

**Permisos.** Meta exige, además de los de anuncios:
`leads_retrieval`, `pages_show_list`, `pages_read_engagement`, `pages_manage_ads`.

- Cada sincronización vuelve a preguntarle a Meta qué permisos tiene el acceso
  (`/me/permissions`) y guarda lo de hoy. Cuando se concede `leads_retrieval`
  no hay que reconectar: basta «Sincronizar» o «Comprobar permiso» en
  *Leads y ventas → Formularios instantáneos*.
- Para que el botón «Conectar con Facebook» pida esos permisos, definir en el
  servidor `META_ADS_EXTRA_SCOPES=leads_retrieval,pages_show_list,pages_read_engagement,pages_manage_ads`.
  Solo cuando la app de Meta ya los tenga aprobados: pedir un permiso sin
  aprobar hace que Meta rechace todo el inicio de sesión de quien no tiene rol
  en la app.

**Reglas.**

- Solo se consultan anuncios de campañas de clientes potenciales o que ya
  reportaron leads (máximo 40 por pasada, primero los activos).
- Primera importación: últimos 60 días. Las siguientes: desde la última
  importación completa, con 30 minutos de margen.
- Sin permiso no se guarda nada inventado: queda dicho por qué. Los leads que
  llegaron por aviso sin datos se completan solos al llegar el permiso.
- Los datos personales viven en el contacto; en el lead solo quedan los
  identificadores y los nombres de los campos del formulario.
- Un contacto que ya existía (mismo teléfono o correo) conserva su primer origen.
- Se apaga con `ADS_CRON_DISABLED=1`, igual que la sincronización.

**Rutas.** `GET /ads/leads/status` (lectura), `POST /ads/leads/import`
(administración, 4 por minuto), además de las que ya existían.

## Analista con IA

**Qué hace.** En *Resultados*, escribe qué está pasando con la publicidad y qué
hacer esta semana: lo que funciona, lo que no, hasta 4 acciones con prioridad,
qué vigilar y qué falta medir. También responde una pregunta puntual
(«¿qué anuncio pauso?»).

**Qué NO hace.** No calcula, no ejecuta y no cambia nada en la cuenta.

- Recibe solo agregados ya calculados por el código (resultados del periodo,
  campañas, 15 anuncios con más gasto, hallazgos abiertos de la auditoría y el
  embudo del CRM). Ningún nombre, teléfono ni correo de contactos.
- Toda cifra que escriba debe existir en esos datos. Lo que cite una cifra que
  no está se descarta (el punto o la acción completos; del resumen, la frase) y
  se le pide corregir una vez. La pantalla dice cuántas afirmaciones se
  descartaron.
- Las acciones que aumentan el gasto (subir, activar, duplicar) quedan
  marcadas: las decide una persona.

**Con qué IA.** La de la empresa (su llave) o, si el equipo la autorizó, la IA
de prueba (un análisis = un uso del cupo diario). Sin IA la tarjeta lo explica
y todo lo demás sigue con reglas. El consumo queda en «Consumo IA» con el
propósito `ads.analysis`.

**Costo.** El último análisis se guarda por empresa: abrir la pantalla no
gasta. Solo gasta «Analizar con IA», «Actualizar análisis» y cada pregunta
(6 por minuto como máximo).

**Rutas.** `GET /ads/ai/analysis` (lectura), `POST /ads/ai/analysis`
(administración).
