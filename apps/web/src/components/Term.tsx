import type { ReactNode } from 'react';

/**
 * Glosario de publicidad en palabras simples. Cada término técnico de Ads
 * lleva su explicación corta al pasar el mouse o tocarlo (también con teclado).
 */
export const GLOSSARY: Record<string, { term: string; short: string }> = {
  impressions: { term: 'Impresiones', short: 'Cuántas veces se mostró tu anuncio en pantalla. Una misma persona puede verlo varias veces.' },
  reach: { term: 'Alcance', short: 'Cuántas personas distintas vieron tu anuncio al menos una vez.' },
  frequency: { term: 'Frecuencia', short: 'Cuántas veces, en promedio, vio tu anuncio cada persona. Más de 3 o 4 suele cansar.' },
  clicks: { term: 'Clics', short: 'Cuántas veces tocaron tu anuncio para ir a tu WhatsApp, tu web o tu formulario.' },
  ctr: { term: 'CTR', short: 'De cada 100 personas que vieron el anuncio, cuántas le dieron clic. Entre más alto, más llama la atención.' },
  cpc: { term: 'CPC', short: 'Costo por clic: lo que pagas, en promedio, cada vez que alguien toca tu anuncio.' },
  cpm: { term: 'CPM', short: 'Lo que cuesta mostrar tu anuncio 1.000 veces. Sirve para saber qué tan caro está llegar a tu público.' },
  cpa: { term: 'Costo por resultado', short: 'Lo que pagas por cada cosa que buscabas: un mensaje, un registro o una venta.' },
  costPerConversation: { term: 'Costo por conversación', short: 'Lo que pagas por cada persona que te escribe por WhatsApp o Messenger desde el anuncio.' },
  roas: { term: 'ROAS', short: 'Por cada peso invertido en publicidad, cuántos pesos vendiste. 3 significa que vendiste el triple de lo que gastaste.' },
  conversions: { term: 'Conversiones', short: 'Las acciones valiosas que hizo la gente después del anuncio: escribirte, dejar sus datos o comprar.' },
  conversations: { term: 'Conversaciones', short: 'Personas que te escribieron por WhatsApp, Messenger o Instagram desde el anuncio.' },
  leads: { term: 'Leads', short: 'Personas interesadas que te dejaron sus datos (nombre, teléfono) en un formulario del anuncio.' },
  cpl: { term: 'CPL', short: 'Costo por lead: lo que pagaste, en promedio, por cada persona que dejó sus datos.' },
  cac: { term: 'CAC', short: 'Costo de conseguir un cliente: lo que gastaste en publicidad dividido entre los clientes que compraron.' },
  spend: { term: 'Gasto', short: 'Lo que Meta o Google te cobró por mostrar tus anuncios en ese periodo.' },
  budget: { term: 'Presupuesto diario', short: 'El máximo que el anuncio puede gastar en un día. Meta puede gastar un poco más un día y menos otro, pero respeta el promedio.' },
  campaign: { term: 'Campaña', short: 'La carpeta que agrupa tus anuncios con un mismo objetivo (por ejemplo, conseguir mensajes por WhatsApp).' },
  adset: { term: 'Conjunto de anuncios', short: 'Dentro de una campaña, define a quién se muestra (público, lugar, edad) y cuánto se gasta.' },
  ad: { term: 'Anuncio', short: 'Lo que la gente ve: la imagen o video, el texto y el botón.' },
  objective: { term: 'Objetivo', short: 'Lo que le pides a Meta que consiga: mensajes, visitas a tu web, registros o ventas. Meta busca a las personas más probables de hacerlo.' },
  audience: { term: 'Público', short: 'Las personas a las que se muestra tu anuncio: lugar, edad e intereses.' },
  pixel: { term: 'Píxel', short: 'Un código de Meta en tu página web que cuenta qué hace la gente después de ver tu anuncio (por ejemplo, si compró).' },
  attribution: { term: 'Atribución', short: 'Saber qué anuncio trajo cada venta o cliente, para invertir más en lo que funciona.' },
  utm: { term: 'UTM', short: 'Una etiqueta que se agrega al enlace del anuncio para saber, en tu web, que la visita vino de ese anuncio.' },
  learning: { term: 'Fase de aprendizaje', short: 'Los primeros días de un anuncio, cuando Meta todavía está probando a quién mostrarlo. Los resultados suben y bajan; no conviene tocarlo.' },
  autopilot: { term: 'Autopilot', short: 'Reglas que vigilan tus anuncios y proponen pausarlos o ajustarlos cuando algo va mal. Nunca cambia nada sin tu aprobación, salvo que tú lo actives.' },
};

export function Term({ id, children }: { id: keyof typeof GLOSSARY | string; children?: ReactNode }) {
  const g = GLOSSARY[id];
  if (!g) return <>{children}</>;
  return (
    <span tabIndex={0} className="group/term relative inline cursor-help underline decoration-dotted decoration-1 underline-offset-2 outline-none" aria-label={`${g.term}: ${g.short}`}>
      {children ?? g.term}
      <span role="tooltip" className="pointer-events-none invisible absolute left-1/2 top-full z-50 mt-1 w-60 -translate-x-1/2 border-2 border-ink bg-paper px-3 py-2 text-left text-xs font-normal normal-case leading-snug tracking-normal text-ink opacity-0 shadow-[3px_3px_0_0_rgba(0,0,0,0.15)] transition-opacity group-hover/term:visible group-hover/term:opacity-100 group-focus/term:visible group-focus/term:opacity-100">
        <b className="block">{g.term}</b>{g.short}
      </span>
    </span>
  );
}
