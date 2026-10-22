# Navegación del panel por producto

Estado al 22-oct-2026, en local y sin desplegar.

**Alcance: solo usuarios de empresa (clientes).** El equipo BackOffice (SUPER_ADMIN/DEV) conserva su panel de siempre (`layouts/PlatformSidebar.tsx`): lista de Plataforma, selector de empresa y el panel de la empresa en una lista, con las pestañas internas de Creative y Publicidad.

- La configuración del menú vive en `apps/web/src/layouts/navigation.ts`. Es lógica pura y tiene sus propias pruebas.
- El componente es `apps/web/src/layouts/Sidebar.tsx`.
- El acceso lo sigue exigiendo el servidor (`ProductsGuard`) y cada ruta (`RequireProduct`). Ver [productos-y-arquitectura.md](productos-y-arquitectura.md).

## Estructura

1. **Selector de producto** (arriba): Automation, Creative y Ads Intelligence, cada uno con
   nombre, ícono y descripción.
   - El activo se marca con fondo invertido, check, `aria-current` y el texto accesible
     "(producto activo)". No depende solo del color.
   - Un producto no contratado aparece como "No activo · ver opciones" (borde punteado
     y candado) y lleva a `/app/producto/:key`, donde se pide la activación.
2. **Menú del producto activo**, agrupado por tareas. Cambia al cambiar de producto.
3. **Empresa y cuenta** (global, igual en los tres): Configuración, Equipo, Mi plan,
   Facturación, Consumo IA y, durante la configuración inicial, Primeros pasos. La
   seguridad de la cuenta (contraseña y verificación en dos pasos) sigue al pie, junto al usuario.

**Al cambiar de producto** se vuelve a la última pantalla que usaste en ese producto
(se guarda en el navegador). Solo la primera vez se va a su inicio.

**Rutas globales y biblioteca:** las pantallas globales y la biblioteca no cambian el
producto activo. En la biblioteca queda el último entre Creative y Ads.

**Menú contraído (escritorio):** quedan solo los íconos, cada uno con su nombre accesible
y tooltip. Se recuerda por navegador. En el celular el menú es un panel lateral, siempre expandido.

## Mapa

### Antes
Una sola lista de unos 30 ítems:
- Dashboard, Conversaciones, Pedidos, Reportes, Clientes, Vista por área, Domicilios, Marketing.
- Creative y Publicidad, con 8 y 7 pestañas internas.
- Biblioteca, Contactos, Campañas, Reactivación, Cobranza, Auditor, Agenda.
- Asistentes IA, Automatizaciones, Integraciones, Galería, Analytics, Costos de IA, Gerencia.
- Consumo IA, Mi plan, Facturación, Equipo, Configuración.


### Ahora

**Automation:**
- **Inicio:** Resumen, Analítica, Reporte a gerencia.
- **Atención y canales:** Conversaciones, Canales e integraciones, Galería para chats.
- **Ventas y clientes:** Contactos, Clientes, Oportunidades (nueva vista del Radar existente,
  fuente CRM), Campañas por WhatsApp, Reactivación, Cobranza, Auditor de ventas.
- **Automatización:** Asistentes IA, Flujos y reglas, Costo del asistente.
- **Operaciones:** Pedidos, Reportes de pedidos, Vista por área, Domicilios, Agenda, Mi negocio / Ajustes de pedidos.

**Creative:**
- **Inicio:** Inicio de Creative.
- **Diseños:** Mis diseños, que incluye crear, editar, adaptar, revisar y exportar.
- **Marca:** Identidad de marca.
- **Biblioteca creativa:** la Biblioteca compartida.
- **Calendario y publicación:** Calendario, Reglas de publicación, Piezas y redes, Créditos de contenido.

**Ads Intelligence:**
- **Resumen publicitario:** Resultados.
- **Campañas y cuentas:** Campañas, Nueva campaña, Cuentas publicitarias.
- **Creatividades y recursos:** la Biblioteca compartida. "Traer un diseño de Creative" aparece solo con los dos productos.
- **Inteligencia y oportunidades:** Oportunidades, con contador.
- **Automatización publicitaria:** Autopilot y reglas, con contador.
- **Leads, ventas y atribución:** Leads y ventas.

## Decisiones
- **Conversaciones en "Atención y canales":** son el canal de atención. La venta se trabaja
  en contactos, oportunidades y seguimientos.
- **Pestañas internas de Creative y Ads:** se quitaron porque duplicaban el menú lateral. Cada
  pantalla se titula con su grupo y sección, y las URLs `?tab=` siguen funcionando.
- **Pestaña "Recursos" de Creative:** era una segunda biblioteca. Ahora `?tab=recursos` redirige a
  la Biblioteca compartida, que ganó lo que tenía aquella: tipo Imagen/Logo/Referencia
  y el aviso de derechos de uso.
- **Oportunidades del CRM:** antes solo se veían dentro de Creative. Ahora están en Automation
  (`/app/oportunidades`). La pestaña de Creative sigue accesible desde su Inicio.
- **Integraciones:** no se movieron a un espacio global, porque no hay conexiones compartidas.
  Los canales (WhatsApp, Instagram, Messenger) son de Automation, las cuentas publicitarias
  de Ads, y la conexión de redes para publicar está en Creative.

## Barra estrecha de íconos
En el repositorio la única barra estrecha es la paleta del editor de Creative (Texto,
Forma, Círculo, Línea, Imagen).
- Es un acceso rápido a herramientas del lienzo, no navegación. No duplica nada y no es de desarrollo.
- Se conservó. Las etiquetas antes se cortaban ("Rectán", "Circul") y ahora se leen completas.
- Lleva `role="toolbar"` y un nombre accesible en cada botón.

El menú contraído es la otra vista en íconos, y es la misma navegación.

## Pruebas
`pnpm --filter @backoffice/web test` (Vitest + Testing Library + jsdom). Cubre:
- Grupos de cada producto.
- Producto activo por ruta.
- Que cada opción del menú apunte a una ruta existente.
- El selector: cambio, retomar la última pantalla y rutas globales.
- Combinaciones de productos.
- Rol de área y solo lectura.
- Que el panel de plataforma siga igual que antes.
- Menú contraído y expandido, y celular.
