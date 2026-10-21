import { readFileSync } from 'fs';
import { join } from 'path';
import { codeBlueprint, codeInterviewTurn, parseMoney, parseProducts, parseSchedule, toPairs, wishToNeed } from '../src/common/blueprint-engine';
import { compareBlueprints, textSim } from '../src/common/blueprint-similarity';
import { CORPUS, conversation, ownerAnswers } from './fixtures/blueprint-corpus';
import { toComparable } from './fixtures/blueprint-compare';

const refs = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'blueprint-ai-reference.json'), 'utf8'));

describe('registro sin IA: el código arma la empresa', () => {
  it('se parece al menos 70 % a la IA en promedio (y ningún negocio baja de 65 %)', () => {
    const scores = CORPUS.map((c) => {
      const a = ownerAnswers(c);
      return { id: c.id, score: compareBlueprints(toComparable(codeBlueprint(c.answers), a), toComparable(refs[c.id].raw, a)).score };
    });
    const avg = scores.reduce((n, s) => n + s.score, 0) / scores.length;
    // eslint-disable-next-line no-console
    console.log(`Parecido código vs IA: ${avg.toFixed(1)} % · ${scores.map((s) => `${s.id} ${s.score}`).join(' · ')}`);
    expect(avg).toBeGreaterThanOrEqual(70);
    for (const s of scores) expect(s.score).toBeGreaterThanOrEqual(65);
  });

  it('el medidor da 100 % a la IA contra sí misma y castiga un plano vacío', () => {
    const c = CORPUS[0];
    const ai = toComparable(refs[c.id].raw, ownerAnswers(c));
    expect(compareBlueprints(ai, ai).score).toBe(100);
    expect(compareBlueprints(toComparable({}, ownerAnswers(c)), ai).score).toBeLessThan(40);
    expect(textSim('Métodos de pago', 'metodo pagos')).toBe(1);
  });

  it('lee precios, horarios y listas como los escribe un dueño', () => {
    expect(parseMoney('120.000')).toBe(120000);
    expect(parseMoney('1.800.000')).toBe(1800000);
    expect(parseMoney('35 mil')).toBe(35000);
    expect(parseMoney('60k')).toBe(60000);
    expect(parseSchedule('Lunes a viernes de 11 am a 3 pm')).toEqual({ days: [1, 2, 3, 4, 5], open: '11:00', close: '15:00' });
    expect(parseSchedule('lunes a sábado de 9 am a 8 pm y domingos de 10 a 2')).toEqual({ days: [1, 2, 3, 4, 5, 6], open: '09:00', close: '20:00' });
    expect(parseSchedule('desde las 9 de la mañana')).toBeNull();
    const p = parseProducts([['¿Qué vendes?', 'Tortas desde 60.000, cupcakes la docena a 45.000 y mesas de postres'], ['¿Cómo pagan?', 'La mitad para separar por Nequi']]);
    expect(p).toEqual([{ name: 'Tortas', price: 60000 }, { name: 'Cupcakes', price: 45000 }, { name: 'Mesas de postres', price: null }]);
    expect(wishToNeed('agende citas')).toBe('Agendar citas');
  });

  it('una marca de ropa sale como ropa: sin menú, con tallas, envíos y precios', () => {
    const raw: any = codeBlueprint(CORPUS.find((c) => c.id === 'ropa')!.answers);
    expect(raw).toMatchObject({ rubro: 'VENTAS', empresa: { nombre: 'Lúa', ciudad: 'Medellín' } });
    expect(raw.herramientas).not.toContain('menu');
    expect(raw.respuestas_rapidas.map((r: any) => r.atajo)).toEqual(expect.arrayContaining(['tallas', 'precios', 'pago', 'envio']));
    expect(raw.productos).toEqual(expect.arrayContaining([expect.objectContaining({ nombre: 'Vestidos', precio: 120000 })]));
    expect(raw.asistente.bienvenida).toContain('Lúa');
  });

  it('sin IA pregunta solo lo que falta, con opciones de su negocio', () => {
    const ropa = conversation(CORPUS.find((c) => c.id === 'ropa')!);
    // Con 3 respuestas ya sabe qué vende (blusas, vestidos y jeans): pregunta qué le preguntan
    expect(codeInterviewTurn(toPairs(ropa.slice(0, 6))).pregunta).toMatch(/preguntan primero/);
    const t1 = codeInterviewTurn(toPairs(ropa.slice(0, 8)));
    expect(t1.listo).toBe(false);
    // Ya contó qué le preguntan: sigue con la entrega
    expect(t1.pregunta).toMatch(/llegan los pedidos/);
    expect(t1.opciones).toContain('Envío por transportadora');
    const full = toPairs(conversation(CORPUS.find((c) => c.id === 'ropa')!));
    // Solo le falta el horario; al contestarlo termina
    expect(codeInterviewTurn(full).pregunta).toMatch(/horario/);
    expect(codeInterviewTurn([...full, ['¿Qué días y en qué horario atiendes?', 'Lunes a sábado de 9 am a 6 pm']], 9).listo).toBe(true);
    const odonto = toPairs(conversation(CORPUS.find((c) => c.id === 'odonto')!).slice(0, 4));
    expect(codeInterviewTurn(odonto).pregunta).not.toMatch(/llegan los pedidos/); // un consultorio no despacha pedidos
  });
});
