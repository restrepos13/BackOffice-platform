import { Mail, MessageCircle } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { LEGAL_LINKS, LegalFooterLinks } from './legal-links';
import { CIUDAD, EMAIL, LEGAL_UPDATED, RESPONSABLE, WA_TEXT, mailLink, waLink } from './public-info';

/**
 * Páginas públicas que piden Meta, Google y TikTok para revisar una app:
 * privacidad, términos, eliminación de datos y contacto. Todo lo que se afirma
 * aquí está verificado contra el código de la plataforma; si algo cambia en el
 * servidor (permisos, desconexión, borrado), hay que revisar estos textos.
 */

function LegalLayout({ title, kicker, children }: { title: string; kicker: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} — BackOffice`;
    window.scrollTo(0, 0);
  }, [title]);
  return (
    <div className="min-h-screen bg-bone text-ink">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-5 md:px-6">
        <Link to="/" className="display text-2xl leading-none">BackOffice<span className="text-ok">.</span></Link>
        <Link to="/login" className="bg-ink px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-bone hover:bg-ink-2">
          Iniciar sesión
        </Link>
      </header>

      <nav aria-label="Páginas legales" className="mx-auto max-w-5xl overflow-x-auto px-4 md:px-6">
        <ul className="flex min-w-max border-2 border-ink bg-paper">
          {LEGAL_LINKS.map((l, i) => (
            <li key={l.to} className={i > 0 ? 'border-l-2 border-ink' : ''}>
              <NavLink
                to={l.to}
                className={({ isActive }) => `block px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.06em] ${isActive ? 'bg-ink text-bone' : 'hover:bg-bone-2'}`}
              >
                {l.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <main className="mx-auto max-w-5xl px-4 pb-16 pt-8 md:px-6">
        <p className="kicker">{kicker}</p>
        <h1 className="display mt-1 text-[clamp(2.2rem,6vw,3.75rem)] leading-[0.95]">{title}</h1>
        <div className="mt-6">{children}</div>
      </main>

      <footer className="border-t-2 border-ink">
        <div className="mx-auto flex max-w-5xl flex-wrap items-start justify-between gap-4 px-4 py-6 text-xs text-ink-3 md:px-6">
          <p>© {new Date().getFullYear()} BackOffice · proyecto en desarrollo · {CIUDAD.split(',')[0]}, Colombia</p>
          <LegalFooterLinks />
        </div>
      </footer>
    </div>
  );
}

/* ── Bloques de texto ── */

function Doc({ children }: { children: ReactNode }) {
  return <article className="space-y-8 border-2 border-ink bg-paper p-5 text-[15px] leading-relaxed md:p-8 [&_a]:underline">{children}</article>;
}

function Section({ n, title, children }: { n?: string; title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{n && <span className="mr-2 text-ok">{n}</span>}{title}</h2>
      {children}
    </section>
  );
}

function List({ items, ordered = false }: { items: ReactNode[]; ordered?: boolean }) {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className={`space-y-1.5 pl-5 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-ink-3`}>
      {items.map((it, i) => <li key={i}>{it}</li>)}
    </Tag>
  );
}

function Updated() {
  return <p className="text-xs text-ink-3">Última actualización: {LEGAL_UPDATED}.</p>;
}

/** Quién presta el servicio, sin atribuir una sociedad que no existe. */
function Identity() {
  return (
    <div className="space-y-2 border-l-4 border-ink pl-4 text-sm">
      <p>
        <b>BackOffice</b> es un nombre comercial y un proyecto de software en etapa de desarrollo y validación. Todavía no está
        constituido como sociedad, por lo que no tiene razón social, NIT ni registro mercantil propios.
      </p>
      <p>
        Persona responsable del servicio y del tratamiento de datos: <b>{RESPONSABLE}</b>, persona natural, con domicilio en {CIUDAD}.
        Correo: <a href={mailLink()}>{EMAIL}</a> · WhatsApp: <a href={waLink()} target="_blank" rel="noreferrer">{WA_TEXT}</a>.
      </p>
    </div>
  );
}

/* ── Política de privacidad ── */

const CONNECTIONS: Array<{ who: string; scopes: string; data: string }> = [
  {
    who: 'Meta: WhatsApp, Instagram y Messenger',
    scopes: 'whatsapp_business_messaging, whatsapp_business_management, business_management, instagram_basic, instagram_manage_messages, pages_messaging, pages_manage_metadata',
    data: 'Mensajes que llegan a los canales del negocio, nombre y número o usuario de quien escribe, y los datos técnicos necesarios para responder por esos canales.',
  },
  {
    who: 'Meta: páginas y publicaciones',
    scopes: 'pages_show_list, pages_read_engagement, pages_manage_posts, instagram_content_publish, business_management',
    data: 'Lista de páginas y cuentas de Instagram del negocio, sus publicaciones y su rendimiento, para programar y publicar las piezas que el negocio aprueba.',
  },
  {
    who: 'Meta Ads',
    scopes: 'ads_read, ads_management, business_management',
    data: 'Cuentas publicitarias, campañas, conjuntos, anuncios y métricas (gasto, alcance, impresiones, clics, resultados). Se usan para mostrarlos, pausar o reanudar con confirmación y crear los anuncios que el negocio arma y confirma.',
  },
  {
    who: 'Google Calendar',
    scopes: 'calendar.calendarlist.readonly, calendar.events',
    data: 'Lista de calendarios, para que el negocio elija uno; horarios ocupados del calendario elegido, para no agendar encima; y los eventos de las citas creadas desde BackOffice.',
  },
  {
    who: 'Google Drive',
    scopes: 'drive.readonly, userinfo.email',
    data: 'Correo de la cuenta conectada, carpetas e imágenes o videos de la carpeta que el negocio elige. Solo se descargan los archivos que el negocio decide importar a su biblioteca. Nunca se modifica ni se borra nada en Drive.',
  },
  {
    who: 'Google Ads',
    scopes: 'adwords',
    data: 'Cuentas a las que el usuario tiene acceso, campañas, grupos de anuncios, anuncios y métricas. Se usan para mostrarlos y para pausar o reanudar con confirmación.',
  },
  {
    who: 'TikTok Ads',
    scopes: 'Permisos de la Marketing API que el usuario aprueba al conectar',
    data: 'Cuentas de anunciante, campañas, grupos de anuncios, anuncios y reportes de métricas. Se usan para mostrarlos y para pausar o reanudar con confirmación.',
  },
];

const PROVIDERS: Array<[string, string]> = [
  ['Render', 'servidores de la plataforma y colas de tareas'],
  ['MongoDB Atlas', 'base de datos'],
  ['Vercel', 'publicación de este sitio y de la interfaz de la plataforma'],
  ['Meta y Twilio', 'envío y recepción de mensajes de WhatsApp'],
  ['DeepInfra, OpenRouter y Google (Gemini)', 'modelos de inteligencia artificial que generan respuestas, textos y la configuración inicial de una empresa'],
  ['Wompi', 'pagos en línea; no guardamos números de tarjeta'],
  ['remove.bg', 'quitar el fondo de una imagen, solo cuando el negocio lo pide en Creative'],
  ['Google Fonts', 'tipografías del sitio'],
];

export function Privacy() {
  return (
    <LegalLayout kicker="Tratamiento de datos personales" title="Política de privacidad">
      <Doc>
        <Updated />
        <p>
          Esta política explica qué información trata BackOffice, para qué la usa, cómo la protege y cómo puedes ejercer tus
          derechos. Se rige por la Ley 1581 de 2012 y el Decreto 1377 de 2013 (compilado en el Decreto 1074 de 2015) de Colombia, y
          por las políticas de datos de las plataformas con las que nos integramos.
        </p>

        <Section n="1." title="Quién es responsable">
          <Identity />
          <p>Hay dos situaciones distintas:</p>
          <List
            items={[
              <>Para los datos de los <b>negocios que usan BackOffice y de las personas de su equipo</b>, el responsable es la persona indicada arriba.</>,
              <>Para los datos de los <b>clientes de cada negocio</b> (quienes le escriben, compran o agendan), el responsable es ese negocio. BackOffice actúa como <b>encargado</b>: trata esos datos solo para prestarle el servicio y según sus instrucciones.</>,
            ]}
          />
        </Section>

        <Section n="2." title="Qué información recogemos">
          <List
            items={[
              <><b>Cuenta y equipo:</b> nombre, correo, teléfono y rol de cada usuario. Las contraseñas se guardan con un algoritmo de hash, nunca en texto. Si se activa la verificación en dos pasos, también su configuración.</>,
              <><b>Información del negocio:</b> nombre, tipo de negocio, catálogo, precios, horarios, instrucciones para el asistente, marca, imágenes y documentos que el negocio carga.</>,
              <><b>Conversaciones:</b> mensajes, notas de voz, imágenes y datos de contacto que los clientes del negocio envían por los canales conectados, y las respuestas que se les dan.</>,
              <><b>Operación:</b> clientes, embudo, pedidos, citas, domicilios, cuentas por cobrar, campañas y reportes.</>,
              <><b>Cuentas conectadas:</b> lo que se detalla en la sección 3.</>,
              <><b>Datos técnicos:</b> registros de acceso, dirección IP y navegador, y un registro de auditoría de las acciones importantes hechas en el panel.</>,
              <><b>Pagos:</b> el valor y el estado de cada pago. No guardamos números de tarjeta.</>,
            ]}
          />
        </Section>

        <Section n="3." title="Información de Meta, Google y TikTok">
          <p>
            Conectar estas cuentas es opcional. Lo hace una persona del negocio con su propio usuario, aprobando los permisos en la
            pantalla de la plataforma; BackOffice nunca pide ni guarda contraseñas de esas cuentas. Solo se piden los permisos
            necesarios para la función que el negocio activa:
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-2 border-ink text-left text-sm">
              <thead className="bg-ink text-bone">
                <tr>
                  <th className="p-2.5 font-semibold">Conexión</th>
                  <th className="p-2.5 font-semibold">Permisos</th>
                  <th className="p-2.5 font-semibold">Qué información se obtiene y para qué</th>
                </tr>
              </thead>
              <tbody>
                {CONNECTIONS.map((c) => (
                  <tr key={c.who} className="border-t-2 border-ink align-top">
                    <td className="p-2.5 font-semibold">{c.who}</td>
                    <td className="p-2.5 font-mono text-xs text-ink-2 [overflow-wrap:anywhere]">{c.scopes}</td>
                    <td className="p-2.5">{c.data}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Las integraciones publicitarias (Meta Ads, Google Ads y TikTok Ads) están en pruebas y dependen de que cada plataforma
            autorice la aplicación. Las acciones que cambian algo en la plataforma externa (publicar, pausar, reanudar o crear un
            anuncio) solo ocurren por decisión del negocio, con su confirmación o según reglas que él mismo configura, y quedan en su
            registro de auditoría.
          </p>
        </Section>

        <Section n="4." title="Uso limitado de los datos de Google">
          <p>
            El uso y la transferencia a cualquier otra aplicación de la información recibida de las API de Google se ajustan a la{' '}
            <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">Política de datos del usuario de los servicios de las API de Google</a>,
            incluidos los requisitos de Uso limitado. En concreto:
          </p>
          <List
            items={[
              'Los datos de Google solo se usan para prestar las funciones que el negocio ve en su panel: citas, biblioteca y publicidad.',
              'No se transfieren a terceros, salvo cuando es necesario para prestar esas funciones, por seguridad o por obligación legal.',
              'No se usan para mostrar publicidad, no se venden y no se usan para evaluar créditos.',
              'No se usan para desarrollar, mejorar ni entrenar modelos de inteligencia artificial generales.',
              'Ninguna persona los lee, salvo con autorización expresa del negocio para darle soporte, por seguridad o por obligación legal.',
            ]}
          />
        </Section>

        <Section n="5." title="Para qué usamos la información">
          <List
            items={[
              'Prestar el servicio: que el asistente responda, que pedidos, citas y cobros funcionen y que el negocio vea sus resultados.',
              'Dar soporte, detectar fallas y proteger la seguridad de las cuentas.',
              'Cobrar el servicio y cumplir obligaciones legales.',
              'Avisar novedades del servicio a los negocios. Se puede pedir no recibirlas.',
            ]}
          />
          <p>
            No vendemos ni alquilamos datos personales. No usamos las conversaciones de los negocios para entrenar modelos de
            inteligencia artificial, ni propios ni de terceros.
          </p>
        </Section>

        <Section n="6." title="Cómo se almacena y protege">
          <List
            items={[
              'La información se guarda en servidores y bases de datos en la nube de los proveedores de la sección 8, que pueden estar fuera de Colombia.',
              'Las conexiones viajan cifradas (HTTPS).',
              'Los tokens de acceso de las cuentas conectadas y otras credenciales se guardan cifrados con AES-256-GCM, nunca se muestran completos en el panel y no viajan en direcciones web.',
              'Acceso por roles: administrador, solo lectura, área y domiciliario ven únicamente lo que su rol permite.',
              'Verificación en dos pasos disponible, bloqueo temporal tras varios intentos fallidos de inicio de sesión y registro de auditoría.',
            ]}
          />
          <p className="text-sm text-ink-2">
            Ningún sistema es completamente invulnerable. Si detectamos un incidente que afecte datos personales, avisaremos a los
            negocios afectados y a la autoridad cuando la ley lo exija.
          </p>
        </Section>

        <Section n="7." title="Cómo se separan los datos de cada empresa">
          <p>
            BackOffice es multiempresa: cada negocio tiene su propio espacio. Cada registro guardado (clientes, conversaciones,
            pedidos, cuentas conectadas) pertenece a una sola empresa, y el servidor filtra cada consulta por la empresa del usuario
            que la hace. Un usuario de una empresa no puede ver datos de otra. Solo el equipo de BackOffice tiene acceso de soporte a
            varias empresas, y lo usa para dar soporte y mantener la plataforma.
          </p>
        </Section>

        <Section n="8." title="Proveedores externos que intervienen">
          <p>Para prestar el servicio usamos estos proveedores, cada uno solo para su función:</p>
          <List items={PROVIDERS.map(([n, f]) => <><b>{n}:</b> {f}.</>)} />
          <p>
            Además, Meta, Google y TikTok reciben las solicitudes necesarias cuando un negocio conecta sus cuentas. Algunos
            proveedores tienen servidores fuera de Colombia; la transferencia se hace solo para prestar el servicio y con las
            garantías que exige la ley.
          </p>
        </Section>

        <Section n="9." title="Tokens, autorizaciones y cómo revocar una conexión">
          <p>
            Cuando un negocio conecta una cuenta, la plataforma le entrega a BackOffice un token de acceso limitado a los permisos
            aprobados. Ese token se guarda cifrado y se usa solo para las funciones descritas. Para revocarlo:
          </p>
          <List
            items={[
              <><b>Desde BackOffice:</b> el administrador del negocio pulsa «Desconectar» en la cuenta (Canales, Biblioteca o Ads → Cuentas). El token se borra en ese momento; en Google Drive además se revoca el permiso ante Google.</>,
              <><b>Desde la plataforma:</b> quitando el acceso de BackOffice en la configuración de Facebook (Integraciones comerciales), en <a href="https://myaccount.google.com/connections" target="_blank" rel="noreferrer">myaccount.google.com/connections</a> o en la configuración de TikTok for Business.</>,
            ]}
          />
          <p>El paso a paso está en <Link to="/eliminacion-de-datos">eliminación de datos</Link>.</p>
        </Section>

        <Section n="10." title="Acceso, corrección y eliminación">
          <p>Como titular de los datos puedes:</p>
          <List
            items={[
              'Conocer, actualizar y corregir tus datos.',
              'Pedir prueba de la autorización que diste y saber cómo se han usado.',
              'Revocar la autorización y pedir que se eliminen, cuando no exista un deber legal o contractual de conservarlos.',
              'Presentar quejas ante la Superintendencia de Industria y Comercio, después de haber hecho tu solicitud ante nosotros.',
            ]}
          />
          <p>
            Escribe a <a href={mailLink('Derechos sobre mis datos')}>{EMAIL}</a> o por WhatsApp. Respondemos las consultas en máximo
            10 días hábiles y los reclamos en máximo 15 días hábiles, como indica la ley. Si eres cliente de un negocio que usa
            BackOffice, también puedes dirigirte a ese negocio; le ayudaremos a atender tu solicitud.
          </p>
          <p>El administrador de un negocio también puede corregir la información directamente en el panel y descargar los datos de su empresa en PDF.</p>
        </Section>

        <Section n="11." title="Qué pasa con los datos al terminar una cuenta">
          <p>
            Cuando un negocio deja el servicio, puede pedir una copia de sus datos durante los 30 días siguientes. Después, o antes si
            así lo solicita, eliminamos su información. Hoy ese borrado lo hace el equipo de BackOffice de forma manual (no es
            automático) y se confirma por escrito. Solo conservamos lo que la ley obligue a guardar, como soportes de pagos, y
            únicamente por el tiempo exigido. Si el proveedor de base de datos mantiene copias de seguridad, la información
            desaparece de ellas cuando esas copias expiran.
          </p>
        </Section>

        <Section n="12." title="Menores de edad">
          <p>BackOffice es un servicio para negocios. No está dirigido a menores de 18 años.</p>
        </Section>

        <Section n="13." title="Cambios a esta política">
          <p>Si cambiamos algo importante, lo publicaremos en esta página con una nueva fecha de actualización y lo avisaremos a los negocios.</p>
        </Section>
      </Doc>
    </LegalLayout>
  );
}

/* ── Términos y condiciones (versión pública) ── */

export function Terms() {
  return (
    <LegalLayout kicker="Condiciones de uso" title="Términos y condiciones">
      <Doc>
        <Updated />
        <p>
          Estos términos regulan el uso de BackOffice, la plataforma en la nube que ayuda a negocios a atender, vender y organizar
          su operación con apoyo de inteligencia artificial. Al crear una cuenta o usar la plataforma aceptas estos términos en
          nombre de tu negocio.
        </p>

        <Section n="1." title="Quién presta el servicio">
          <Identity />
        </Section>

        <Section n="2." title="Estado del servicio">
          <List
            items={[
              'BackOffice está en desarrollo y validación. Algunas funciones están disponibles, otras en pruebas y otras planeadas; el estado actualizado se publica en la página principal.',
              'Las integraciones con Meta Ads, Google Ads y TikTok Ads dependen de que cada plataforma autorice la aplicación. BackOffice no está afiliado ni respaldado por esas empresas.',
              'Podemos mejorar, cambiar o retirar funciones. Si un cambio afecta algo esencial de tu plan, te avisaremos con anticipación razonable.',
            ]}
          />
        </Section>

        <Section n="3." title="Tu cuenta y la supervisión humana">
          <List
            items={[
              'Debes dar datos reales, mantenerlos actualizados y cuidar el acceso de las personas de tu equipo.',
              'El asistente responde con la información que tu negocio carga. Revisa que sea correcta: la IA puede equivocarse, y una persona de tu equipo debe estar pendiente del panel.',
              'Quien acepta estos términos declara tener facultad para hacerlo en nombre del negocio.',
            ]}
          />
        </Section>

        <Section n="4." title="Canales y cuentas de terceros">
          <List
            items={[
              'El uso de WhatsApp, Instagram, Messenger y de las plataformas publicitarias se rige también por las políticas de Meta, Google y TikTok. Tu negocio es responsable de cumplirlas.',
              'Solo puedes escribir a personas que te dieron su número y aceptaron recibir mensajes. Están prohibidos el spam y el contenido ilegal, engañoso u ofensivo.',
              'Las cuentas publicitarias, su presupuesto y sus anuncios son de tu negocio. BackOffice solo ejecuta las acciones que tú confirmas o configuras.',
              'Si una plataforma suspende tu número o tu cuenta por incumplir sus políticas, BackOffice no responde por esa suspensión.',
            ]}
          />
        </Section>

        <Section n="5." title="Precios y pagos">
          <List
            items={[
              'El valor del plan depende del tipo de negocio y de los módulos activos, y se confirma por escrito antes de cualquier pago.',
              'Los mensajes de WhatsApp que cobra Meta y el uso de inteligencia artificial son consumos variables; te explicamos cómo se cobran antes de empezar.',
              'Nunca te pediremos datos de tarjeta por WhatsApp ni por correo.',
              'Si un pago no llega en la fecha acordada, podemos suspender el servicio después de avisarte.',
            ]}
          />
        </Section>

        <Section n="6." title="Sin garantía de resultados">
          <p>
            BackOffice es una herramienta. No garantizamos ventas, citas, clientes ni resultados de publicidad: dependen de tu
            negocio, tu oferta, tu presupuesto y tu mercado. Los estimados que mostramos son orientativos.
          </p>
        </Section>

        <Section n="7." title="Datos personales">
          <p>
            El tratamiento de datos se rige por la <Link to="/privacidad">política de privacidad</Link>. Sobre los datos de tus
            clientes, tu negocio es el responsable y BackOffice el encargado. Tu negocio debe contar con la autorización de sus
            clientes y atender sus solicitudes.
          </p>
        </Section>

        <Section n="8." title="Propiedad">
          <List
            items={[
              'El software, la marca y el diseño de BackOffice pertenecen a su responsable. Te damos una licencia de uso mientras tu cuenta esté activa.',
              'Tu contenido (catálogo, imágenes, mensajes, datos) es tuyo. Nos das permiso de usarlo solo para prestarte el servicio.',
            ]}
          />
        </Section>

        <Section n="9." title="Disponibilidad y soporte">
          <p>
            Trabajamos para que el servicio esté disponible, pero puede haber interrupciones por mantenimiento o por fallas de
            proveedores (Meta, proveedores de IA, nube, internet). El soporte se presta por correo y WhatsApp; los canales están en{' '}
            <Link to="/contacto">contacto</Link>.
          </p>
        </Section>

        <Section n="10." title="Cancelación">
          <List
            items={[
              'Puedes cancelar cuando quieras escribiéndonos. El servicio sigue activo hasta el final del periodo pagado.',
              'Podemos suspender o terminar el servicio si incumples estos términos, la ley o las políticas de los canales.',
              <>Al terminar puedes pedir una copia de tus datos y su eliminación, como se explica en <Link to="/eliminacion-de-datos">eliminación de datos</Link>.</>,
            ]}
          />
        </Section>

        <Section n="11." title="Responsabilidad">
          <p>
            En la medida en que la ley lo permita, no respondemos por lucro cesante, pérdida de ventas ni daños indirectos, y la
            responsabilidad total no superará lo pagado por el servicio en los 3 meses anteriores al hecho. Nada de esto limita los
            derechos que la ley colombiana no permite renunciar.
          </p>
        </Section>

        <Section n="12." title="Cambios y ley aplicable">
          <p>
            Podemos actualizar estos términos; si el cambio es importante te avisaremos antes. Se rigen por las leyes de Colombia, y
            cualquier diferencia se intentará resolver primero de forma directa.
          </p>
        </Section>
      </Doc>
    </LegalLayout>
  );
}

/* ── Eliminación de datos ── */

const DISCONNECT: Array<[string, string, string]> = [
  ['WhatsApp, Facebook, Instagram y Messenger', 'Automation → Canales → el canal → Desconectar', 'Se borra el token y BackOffice deja de recibir y enviar mensajes por ese canal.'],
  ['Google Calendar', 'Automation → Canales → Google Calendar → Desconectar', 'Se borra la conexión. Puedes elegir que también se borren de tu calendario los eventos que creó BackOffice.'],
  ['Google Drive', 'Creative → Biblioteca → Google Drive → Desconectar', 'Se revoca el permiso ante Google y se borra la conexión. Los archivos que ya importaste siguen en tu biblioteca hasta que los borres.'],
  ['Meta Ads, Google Ads y TikTok Ads', 'Ads → Cuentas → la cuenta → Desconectar', 'Se borra el token y se detiene la sincronización. El historial de métricas se conserva hasta que pidas eliminarlo.'],
];

export function DataDeletion() {
  return (
    <LegalLayout kicker="Tus datos, tu decisión" title="Eliminación de datos">
      <Doc>
        <Updated />
        <p>
          Aquí explicamos cómo quitarle a BackOffice el acceso a tus cuentas y cómo pedir que eliminemos tu cuenta y los datos
          asociados. Desconectar una cuenta lo puedes hacer tú mismo al instante; <b>eliminar la cuenta completa es hoy un proceso
          manual</b> que hace nuestro equipo.
        </p>

        <Section n="1." title="Desconectar una cuenta desde el panel">
          <p>Un administrador del negocio puede hacerlo sin escribirnos:</p>
          <div className="space-y-2">
            {DISCONNECT.map(([what, where, result]) => (
              <div key={what} className="border-2 border-ink p-3.5">
                <p className="font-semibold">{what}</p>
                <p className="mt-0.5 text-sm"><span className="text-ink-3">Dónde:</span> {where}</p>
                <p className="mt-0.5 text-sm text-ink-2">{result}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section n="2." title="Quitar el permiso desde la otra plataforma">
          <p>Si no tienes acceso al panel, o lo prefieres, puedes revocar el permiso directamente. BackOffice pierde el acceso de inmediato:</p>
          <List
            items={[
              <><b>Facebook:</b> Configuración y privacidad → Configuración → Integraciones comerciales → BackOffice → Eliminar.</>,
              <><b>Instagram:</b> en la configuración, busca «Apps y sitios web» y quita BackOffice.</>,
              <><b>Google (Calendar, Drive y Ads):</b> entra a <a href="https://myaccount.google.com/connections" target="_blank" rel="noreferrer">myaccount.google.com/connections</a>, elige BackOffice y elimina la conexión.</>,
              <><b>TikTok Ads:</b> en TikTok for Business, revisa las aplicaciones autorizadas de tu cuenta y quita la autorización de BackOffice.</>,
            ]}
          />
        </Section>

        <Section n="3." title="Solicitar la eliminación de tu cuenta y tus datos">
          <p>
            Escribe a <a href={mailLink('Solicitud de eliminación de datos')}>{EMAIL}</a> con el asunto <b>«Solicitud de eliminación de
            datos»</b>, o por WhatsApp al{' '}
            <a href={waLink('Hola, quiero solicitar la eliminación de mis datos de BackOffice. Mi empresa es: ')} target="_blank" rel="noreferrer">{WA_TEXT}</a>. Incluye:
          </p>
          <List
            items={[
              'El nombre de tu empresa y el correo con el que entras a BackOffice.',
              'Qué quieres eliminar: toda la cuenta de la empresa, solo los datos de una conexión (por ejemplo, las métricas de Google Ads) o solo tus datos personales.',
              'Si quieres antes una copia de tus datos.',
            ]}
          />
          <p>Lo que pasa después:</p>
          <List
            ordered
            items={[
              'Te confirmamos que recibimos la solicitud.',
              'Verificamos que viene de un correo o teléfono registrado en la cuenta, para que nadie pueda borrar datos ajenos. Si hace falta, te pedimos confirmarlo.',
              'Desconectamos todas las cuentas de Meta, Google y TikTok y borramos sus tokens.',
              'Eliminamos manualmente la empresa, sus usuarios, conversaciones, clientes, pedidos, archivos y métricas.',
              'Te confirmamos por escrito cuando esté hecho. El plazo máximo es de 15 días hábiles desde que verificamos la solicitud.',
            ]}
          />
          <p className="text-sm text-ink-2">
            Solo conservamos lo que la ley obligue a guardar, como soportes de pagos, por el tiempo exigido. Si el proveedor de base
            de datos mantiene copias de seguridad, los datos desaparecen de ellas cuando esas copias expiran.
          </p>
        </Section>

        <Section n="4." title="Si eres cliente de un negocio que usa BackOffice">
          <p>
            Si le escribiste a un negocio que atiende con BackOffice y quieres que borre tu conversación o tus datos, puedes
            pedírselo directamente: ese negocio es el responsable de tus datos. También puedes escribirnos indicando el nombre del
            negocio y tu número; le trasladaremos la solicitud y le ayudaremos a cumplirla.
          </p>
        </Section>
      </Doc>
    </LegalLayout>
  );
}

/* ── Contacto ── */

export function Contact() {
  const card = 'flex flex-col border-2 border-ink bg-paper p-5 shadow-[6px_6px_0_0_rgba(26,26,26,0.9)] transition-transform hover:-translate-y-0.5';
  return (
    <LegalLayout kicker="Soporte y contacto" title="Contacto">
      <div className="grid gap-4 md:grid-cols-2">
        <a href={waLink('Hola, tengo una pregunta sobre BackOffice: ')} target="_blank" rel="noreferrer" className={card}>
          <MessageCircle size={22} strokeWidth={1.8} />
          <p className="kicker mt-4">WhatsApp</p>
          <p className="display text-3xl">{WA_TEXT}</p>
          <p className="mt-2 text-sm text-ink-2">Soporte, preguntas sobre la plataforma y nuevos negocios.</p>
        </a>
        <a href={mailLink()} className={card}>
          <Mail size={22} strokeWidth={1.8} />
          <p className="kicker mt-4">Correo</p>
          <p className="display break-all text-2xl">{EMAIL}</p>
          <p className="mt-2 text-sm text-ink-2">Solicitudes formales: privacidad, eliminación de datos y pagos.</p>
        </a>
      </div>

      <div className="mt-6">
        <Doc>
          <Section title="Quién responde">
            <Identity />
            <p className="text-sm text-ink-2">Todavía no tenemos un correo con el dominio propio; mientras tanto atendemos desde el correo indicado.</p>
          </Section>
          <Section title="Horario">
            <p>Lunes a viernes, en horario hábil de Colombia. Fuera de ese horario respondemos el siguiente día hábil.</p>
          </Section>
          <Section title="Si ya tienes cuenta">
            <p>
              <Link to="/login">Inicia sesión</Link> en la plataforma. Al escribirnos, incluye el nombre de tu empresa, el correo con el
              que entras y qué pasó; una captura de pantalla ayuda. Nunca te pediremos tu contraseña, códigos de verificación ni datos
              de tarjeta: no los envíes por ningún canal.
            </p>
          </Section>
          <Section title="Datos personales">
            <p>
              Para conocer, corregir o eliminar tus datos, o desconectar una cuenta, revisa la <Link to="/privacidad">política de
              privacidad</Link> y el <Link to="/eliminacion-de-datos">procedimiento de eliminación de datos</Link>.
            </p>
          </Section>
        </Doc>
      </div>
    </LegalLayout>
  );
}
