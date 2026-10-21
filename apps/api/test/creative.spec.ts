/**
 * BackOffice Creative: aislamiento entre empresas, editor por capas
 * (documento validado y versionado), créditos sin cobros dobles ni saldos
 * negativos, y publicación con aprobación y reglas de autonomía.
 */
import { CreativeService } from '../src/modules/creative.module';
import { DesignDocError, FORMATS, blankDoc, validateDesignDoc } from '../src/common/design-doc';
import { buildTemplate, TEMPLATES } from '../src/common/creative-templates';
import { DEFAULT_POLICY, imageInfo, reviewDecision } from '../src/common/creative-policy';
import {
  InsufficientCreditsError, commitCreativeCredits, grantExtraCredits, releaseCreativeCredits, reserveCreativeCredits,
} from '../src/common/creative-credits';
import { assertSchedulable, resetApproval } from '../src/common/creative-guard';
import { createMockPrisma } from './helpers/mock-prisma';

const audit = { log: jest.fn(async () => undefined) };
const A = { id: 'uA', name: 'Admin A', email: 'a@a.co', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };
const B = { id: 'uB', name: 'Admin B', email: 'b@b.co', role: 'COMPANY_ADMIN' as const, companyId: 'coB' };

function world() {
  const { prisma, db } = createMockPrisma();
  const social = JSON.stringify({ social: { enabled: true, credits: 3 } });
  db.company.push(
    { id: 'coA', name: 'Lúa', planId: 'p1', addonsJson: social, timezone: 'America/Bogota' },
    { id: 'coB', name: 'Otra', planId: 'p1', addonsJson: social, timezone: 'America/Bogota' },
    { id: 'coSinPlan', name: 'Sin plan', planId: null },
  );
  return { prisma, db, svc: new CreativeService(prisma as any, audit as any) };
}

/** PNG mínimo con el ancho y alto pedidos (solo la cabecera; basta para validar tamaño y tipo). */
function pngOf(w: number, h: number): any {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return { buffer: b, size: b.length, originalname: 'x.png', mimetype: 'image/png' };
}

describe('Creative · aislamiento entre empresas', () => {
  it('B no lee, no edita, no exporta ni descarga diseños o recursos de A', async () => {
    const { svc, db } = world();
    const d = await svc.createDesign(A, { templateKey: 'producto', format: 'IG_POST' });
    const asset = await svc.uploadAsset(A, pngOf(400, 400), { kind: 'LOGO' });
    await expect(svc.design(B, d.id)).rejects.toThrow(/no encontrado/);
    await expect(svc.saveDesign(B, d.id, { doc: (d as any).doc, expectedVersion: 1 })).rejects.toThrow(/no encontrado/);
    await expect(svc.uploadExport(B, d.id, pngOf(1080, 1080))).rejects.toThrow(/no encontrado/);
    await expect(svc.deleteAsset(B, asset.id)).rejects.toThrow(/no encontrado/);
    await expect(svc.serveAsset(B, asset.id, {} as any)).rejects.toThrow(/no encontrado/);
    // B no puede meter en SU diseño una imagen de A cambiando el id
    const dB = await svc.createDesign(B, { format: 'IG_POST' });
    const stolen = { ...(dB as any).doc, elements: [{ id: 'img1', type: 'image', name: 'x', assetId: asset.id, x: 0, y: 0, width: 100, height: 100 }] };
    await expect(svc.saveDesign(B, dB.id, { doc: stolen, expectedVersion: 1 })).rejects.toThrow(/no son de tu empresa/);
    // ni ver su saldo: cada uno ve el suyo
    await grantExtraCredits((svc as any).prisma, 'coA', 10, 'g1');
    expect((await svc.credits(B)).extra).toBe(0);
    expect((await svc.credits(A)).extra).toBe(10);
    // La empresa se toma de la sesión: un companyId en la petición no cambia nada
    expect((await svc.designs(B, 'coA')).map((x: any) => x.id)).toEqual([dB.id]);
  });

  it('sin plan no hay Creative; plataforma elige empresa', async () => {
    const { svc } = world();
    await expect(svc.brand({ ...A, companyId: 'coSinPlan' })).rejects.toThrow(/plan/);
    const dev = { id: 'd', name: 'Dev', email: 'd@x', role: 'DEV' as const, companyId: null };
    expect((await svc.brand(dev, 'coA')).name).toBe('Lúa');
  });
});

describe('Creative · editor por capas', () => {
  it('crea desde plantilla, guarda, reabre y conserva todas las capas y sus cambios', async () => {
    const { svc } = world();
    const d: any = await svc.createDesign(A, { templateKey: 'promo', format: 'STORY' });
    expect(d.doc.elements.length).toBeGreaterThan(3);
    const doc = structuredClone(d.doc);
    const text = doc.elements.find((e: any) => e.type === 'text');
    text.text = 'Nuevo texto';
    text.fill = '#FF0000';
    text.x = 200;
    doc.elements.reverse(); // reordenar capas
    doc.elements[0].locked = true;
    const saved = await svc.saveDesign(A, d.id, { doc, expectedVersion: 1 });
    expect(saved.version).toBe(2);
    const reopened: any = await svc.design(A, d.id);
    expect(reopened.doc.elements.map((e: any) => e.id)).toEqual(doc.elements.map((e: any) => e.id));
    const again = reopened.doc.elements.find((e: any) => e.id === text.id);
    expect(again).toMatchObject({ text: 'Nuevo texto', fill: '#FF0000', x: 200 });
    expect(reopened.doc.elements[0].locked).toBe(true);
  });

  it('dos guardados con la misma versión: el segundo no pisa al primero (409)', async () => {
    const { svc } = world();
    const d: any = await svc.createDesign(A, { format: 'IG_POST' });
    await svc.saveDesign(A, d.id, { doc: d.doc, expectedVersion: 1 });
    await expect(svc.saveDesign(A, d.id, { doc: d.doc, expectedVersion: 1 })).rejects.toThrow(/otra pestaña/);
  });

  it('historial: vuelve a una versión anterior sin perder la actual', async () => {
    const { svc } = world();
    const d: any = await svc.createDesign(A, { templateKey: 'tip', format: 'IG_POST' });
    const doc = structuredClone(d.doc);
    doc.elements = [];
    await svc.saveDesign(A, d.id, { doc, expectedVersion: 1 });
    expect((await svc.versions(A, d.id)).map((v: any) => v.version)).toEqual([2, 1]);
    const r = await svc.restoreVersion(A, d.id, 1);
    expect(r.version).toBe(3);
    expect(((await svc.design(A, d.id)) as any).doc.elements.length).toBe(d.doc.elements.length);
  });

  it('rechaza documentos inválidos y nunca guarda código', () => {
    const ok = blankDoc('IG_POST');
    expect(() => validateDesignDoc({ ...ok, elements: [{ id: 'a', type: 'script', x: 0 }] })).toThrow(DesignDocError);
    expect(() => validateDesignDoc({ ...ok, elements: [{ id: 'a', type: 'text' }, { id: 'a', type: 'text' }] })).toThrow(/repetido/);
    expect(() => validateDesignDoc({ ...ok, elements: Array.from({ length: 151 }, (_, i) => ({ id: `e${i}`, type: 'rect' })) })).toThrow(/máximo/);
    expect(() => validateDesignDoc({ ...ok, schemaVersion: 99 })).toThrow(/versión/);
    expect(() => validateDesignDoc({ ...ok, format: 'STORY' }, 'IG_POST')).toThrow(/formato/);
    const clean = validateDesignDoc({
      ...ok,
      elements: [{ id: 't1', type: 'text', text: '<img src=x onerror=alert(1)>', fontFamily: 'Comic Hack', fill: 'javascript:alert(1)', fontSize: 9999, onClick: 'evil()', __proto__: { x: 1 } }],
    });
    const t: any = clean.elements[0];
    expect(t.fontFamily).toBe('Inter'); // solo fuentes de la lista
    expect(t.fill).toBe('#111111'); // solo colores hex
    expect(t.fontSize).toBe(400); // acotado
    expect(t.onClick).toBeUndefined(); // propiedades desconocidas fuera
    expect(t.text).toContain('<img'); // el texto se guarda como texto: el lienzo lo pinta, no lo interpreta
  });

  it('todas las plantillas sirven en todos los formatos y pasan el validador', () => {
    for (const t of TEMPLATES) for (const f of Object.keys(FORMATS) as any[]) {
      const doc = buildTemplate(t.key, f, { name: 'X', colors: ['#112233'], fonts: ['Poppins'], logoAssetId: null, cta: 'Escríbenos' });
      expect(() => validateDesignDoc(doc, f)).not.toThrow();
    }
  });

  it('exportación: solo PNG/JPEG del tamaño exacto del formato; luego va al calendario como borrador', async () => {
    const { svc, db } = world();
    const d: any = await svc.createDesign(A, { format: 'IG_POST' });
    await expect(svc.toPiece(A, d.id, {})).rejects.toThrow(/Exporta/);
    await expect(svc.uploadExport(A, d.id, pngOf(500, 500))).rejects.toThrow(/1080×1080/);
    await expect(svc.uploadExport(A, d.id, { buffer: Buffer.from('<svg/>'), size: 6 } as any)).rejects.toThrow(/PNG o JPEG/);
    await svc.uploadExport(A, d.id, pngOf(1080, 1080));
    const piece = await svc.toPiece(A, d.id, { title: 'Post', copy: 'Hola', category: 'TIPS' });
    expect(piece.status).toBe('BORRADOR');
    expect(db.contentPiece[0]).toMatchObject({ designId: d.id, designVersion: 1, category: 'TIPS' });
    expect(db.contentPiece[0].approvedAt).toBeFalsy(); // llega sin aprobar
    expect(imageInfo(pngOf(10, 20).buffer)).toEqual({ mime: 'image/png', width: 10, height: 20 });
  });
});

describe('Creative · identidad de marca', () => {
  it('se guarda, persiste y no la sobrescribe la sugerencia; versión vieja → 409', async () => {
    const { svc } = world();
    const saved = await svc.saveBrand(A, { name: 'Lúa', colors: [{ hex: '#ab1234', label: 'Principal' }, { hex: 'rojo' }], fonts: ['Poppins', 'Fuente Pirata'], tone: 'Cercano', offers: [{ text: '2x1 en blusas', price: 65000, validUntil: '2026-12-31' }] });
    expect(saved.colors).toEqual([{ hex: '#AB1234', label: 'Principal' }]);
    expect(saved.fonts).toEqual(['Poppins']);
    const sug = await svc.suggestBrand(A);
    expect(sug.source).toMatch(/revísalos/);
    const after = await svc.brand(A);
    expect(after.tone).toBe('Cercano'); // la sugerencia no tocó lo confirmado
    expect(after.suggestions).toBeTruthy();
    await expect(svc.saveBrand(A, { name: 'X', expectedVersion: 0 })).rejects.toThrow(/Alguien más/);
    await expect(svc.saveBrand(A, { name: 'X', expectedVersion: 1, logos: [{ assetId: 'ajeno' }] })).rejects.toThrow(/logo/);
  });
});

describe('Creative · créditos', () => {
  const company = { id: 'coA', addonsJson: JSON.stringify({ social: { enabled: true, credits: 2 } }) };

  it('reserva → confirma; reintento con la misma llave no cobra dos veces', async () => {
    const { prisma, db } = world();
    const r1 = await reserveCreativeCredits(prisma, { company, operation: 'IMAGE', key: 'img-1' });
    const r2 = await reserveCreativeCredits(prisma, { company, operation: 'IMAGE', key: 'img-1' });
    expect(r1).toMatchObject({ bucket: 'MONTHLY', credits: 1, reused: false });
    expect(r2.reused).toBe(true);
    expect(db.socialUsage[0].credits).toBe(1);
    expect(await commitCreativeCredits(prisma, 'img-1', { provider: 'deepinfra', costUsd: 0.01 })).toBe(true);
    expect(await commitCreativeCredits(prisma, 'img-1')).toBe(false); // idempotente
    expect(await releaseCreativeCredits(prisma, 'img-1')).toBe(false); // lo confirmado no se libera
  });

  it('error técnico: libera la reserva una sola vez', async () => {
    const { prisma, db } = world();
    await reserveCreativeCredits(prisma, { company, operation: 'IMAGE', key: 'img-2' });
    expect(await releaseCreativeCredits(prisma, 'img-2', 'proveedor caído')).toBe(true);
    expect(await releaseCreativeCredits(prisma, 'img-2')).toBe(false);
    expect(db.socialUsage[0].credits).toBe(0);
  });

  it('sin saldo se bloquea; usa los extra; nunca queda negativo, ni con peticiones simultáneas', async () => {
    const { prisma, db } = world();
    await reserveCreativeCredits(prisma, { company, operation: 'IMAGE', key: 'a' });
    await reserveCreativeCredits(prisma, { company, operation: 'IMAGE', key: 'b' });
    await expect(reserveCreativeCredits(prisma, { company, operation: 'IMAGE', key: 'c' })).rejects.toThrow(InsufficientCreditsError);
    await grantExtraCredits(prisma, 'coA', 1, 'pack-1');
    expect(await grantExtraCredits(prisma, 'coA', 1, 'pack-1')).toBe(false); // el mismo paquete no se acredita dos veces
    // Dos peticiones a la vez por el único crédito extra: solo una pasa
    const results = await Promise.allSettled([
      reserveCreativeCredits(prisma, { company, operation: 'IMAGE', key: 'x1' }),
      reserveCreativeCredits(prisma, { company, operation: 'IMAGE', key: 'x2' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(db.creativeWallet[0].extraCredits).toBe(0);
    // Video cuesta más de lo que queda
    await expect(reserveCreativeCredits(prisma, { company, operation: 'VIDEO', key: 'v' })).rejects.toThrow(InsufficientCreditsError);
    expect(db.creativeWallet[0].extraCredits).toBeGreaterThanOrEqual(0);
  });

  it('misma llave enviada dos veces a la vez: un solo cobro', async () => {
    const { prisma, db } = world();
    await Promise.allSettled([
      reserveCreativeCredits(prisma, { company, operation: 'IMAGE', key: 'dup' }),
      reserveCreativeCredits(prisma, { company, operation: 'IMAGE', key: 'dup' }),
    ]);
    expect(db.creativeCreditMove.filter((m: any) => m.idempotencyKey === 'dup')).toHaveLength(1);
    expect(db.socialUsage[0].credits).toBe(1);
  });
});

describe('Creative · publicación híbrida', () => {
  it('la primera pieza siempre la aprueba una persona; luego la autonomía solo cubre lo autorizado', async () => {
    const { svc, db } = world();
    db.contentPiece.push({ id: 'p1', companyId: 'coA', title: 'Consejo', copy: 'Cuida tu ropa así', status: 'BORRADOR', targetsJson: '[]' });
    await svc.savePolicy(A, { autonomyEnabled: true, autoCategories: ['TIPS'] });
    const first = await svc.submit(A, 'p1', { category: 'TIPS' });
    expect(first.status).toBe('EN_REVISION');
    expect(first.reasons.join(' ')).toMatch(/primera publicación/);
    await expect(svc.approve(B, 'p1')).rejects.toThrow(/no encontrada/); // otra empresa no aprueba
    await svc.approve(A, 'p1');
    // Segunda pieza de una categoría autorizada y sin precios: se aprueba sola (queda registrado)
    db.contentPiece.push({ id: 'p2', companyId: 'coA', title: 'Otro consejo', copy: 'Lava a mano', status: 'BORRADOR', targetsJson: '[]' });
    expect((await svc.submit(A, 'p2', { category: 'TIPS' })).status).toBe('APROBADO');
    expect(db.contentPiece[1]).toMatchObject({ autoApproved: true, approvedBy: 'Reglas de autonomía' });
    // Con precio o fuera de categoría: revisión
    db.contentPiece.push({ id: 'p3', companyId: 'coA', title: 'Promo', copy: 'Blusas a $65.000', status: 'BORRADOR', targetsJson: '[]' });
    const p3 = await svc.submit(A, 'p3', { category: 'TIPS' });
    expect(p3.status).toBe('EN_REVISION');
    expect(p3.reasons.join(' ')).toMatch(/precios/);
  });

  it('reglas deterministas: tema restringido y sin autonomía → revisión', () => {
    const policy = { ...DEFAULT_POLICY, autonomyEnabled: true, autoCategories: ['TIPS' as const], restrictedTopics: ['competencia'] };
    expect(reviewDecision({ category: 'TIPS', copy: 'Mejor que la competencia' }, policy, 3).reasons.join()).toMatch(/restringido/);
    expect(reviewDecision({ category: 'TIPS', copy: 'Hola' }, DEFAULT_POLICY, 3).needsReview).toBe(true);
    expect(reviewDecision({ category: 'TIPS', copy: 'Hola' }, policy, 3).needsReview).toBe(false);
  });

  it('no se programa sin aprobación, fuera de horario, en redes no autorizadas ni en pausa; editar quita la aprobación', async () => {
    const { prisma, svc } = world();
    const tomorrow = new Date(Date.now() + 86400e3);
    const at10 = new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 15));
    const piece = { id: 'x', companyId: 'coA', approvedAt: null, status: 'BORRADOR' };
    await expect(assertSchedulable(prisma, piece, at10, ['facebook'])).rejects.toThrow(/aprobación/);
    const ok = { ...piece, approvedAt: new Date() };
    await expect(assertSchedulable(prisma, ok, at10, ['facebook'])).resolves.toBeTruthy();
    await svc.savePolicy(A, { networks: ['facebook'] });
    await expect(assertSchedulable(prisma, ok, at10, ['instagram'])).rejects.toThrow(/no autorizó/);
    await svc.savePolicy(A, { paused: true });
    await expect(assertSchedulable(prisma, ok, at10, ['facebook'])).rejects.toThrow(/pausa/);
    expect(resetApproval('PROGRAMADO')).toMatchObject({ approvedAt: null, status: 'BORRADOR', scheduledAt: null });
  });
});
