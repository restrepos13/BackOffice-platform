/**
 * Privacidad de la IA genérica: lo que va a Gemini, Groq, Cerebras u OpenRouter
 * gratis sale sin teléfonos, correos, documentos, credenciales ni nombres de
 * contactos, y los precios se conservan.
 */
import { sanitizeForGenericAi, sanitizeMessages } from '../src/ai/generic-privacy';

describe('sanitizeForGenericAi', () => {
  it('quita teléfonos colombianos e internacionales en sus formatos comunes', () => {
    const out = sanitizeForGenericAi('Escríbenos al 3108790168, al +57 310 879 0168, al (604) 444 1234 o al 444-1234.');
    expect(out).not.toMatch(/310\s?879|8790168|444/);
    expect(out.match(/\[teléfono\]/g)).toHaveLength(4);
  });

  it('conserva precios, cantidades y horarios', () => {
    const text = 'La torta vale $60.000, el domicilio 5000, el combo 1.250.000 y abrimos de 8 a 18. Pedidos de 2 docenas.';
    expect(sanitizeForGenericAi(text)).toBe(text);
  });

  it('quita correos y documentos (NIT, cédula, C.C., pasaporte)', () => {
    const out = sanitizeForGenericAi('Factura a nombre de NIT 900.123.456-7, cédula 1.036.789.123, C.C. 43567890, pasaporte AB123456 o al correo ventas@doña-rosa.com.co');
    expect(out).not.toMatch(/900\.123|1\.036|43567890|AB123456|ventas@/);
    expect(out).toContain('NIT [documento]');
    expect(out).toContain('[correo]');
  });

  it('reconoce el NIT por su forma aunque no diga NIT', () => {
    expect(sanitizeForGenericAi('Somos 901234567-1 en Medellín')).toBe('Somos [documento] en Medellín');
  });

  it('quita llaves y contraseñas', () => {
    const out = sanitizeForGenericAi('Mi llave es sk-or-v1-abcdefghijklmnop1234567890 y gsk_ABCDEFGHIJKLMNOP1234, la clave: Rosa2026* y token=abc123def456ghi789jkl012mno345pqr678');
    expect(out).not.toMatch(/sk-or-v1-abc|gsk_ABC|Rosa2026|abc123def/);
    expect(out).toContain('clave: [credencial]');
  });

  it('quita nombres de contactos conocidos sin importar mayúsculas ni tildes', () => {
    const out = sanitizeForGenericAi('MARIA PEREZ pidió dos tortas y luego María escribió de nuevo; Pérez pagó.', { names: ['María Pérez'] });
    expect(out).toBe('[contacto] pidió dos tortas y luego [contacto] escribió de nuevo; [contacto] pagó.');
  });

  it('no confunde palabras que contienen un nombre corto', () => {
    expect(sanitizeForGenericAi('Ana compró ananás', { names: ['Ana'] })).toBe('[contacto] compró ananás');
  });

  it('sanea cada mensaje y descarta las imágenes', () => {
    const msgs = sanitizeMessages([
      { role: 'system', content: 'Responde en JSON' },
      { role: 'user', content: [{ type: 'text', text: 'Llama al 3001234567' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } }] },
    ]);
    expect(msgs[0].content).toBe('Responde en JSON');
    expect(msgs[1].content).toBe('Llama al [teléfono]');
  });
});
