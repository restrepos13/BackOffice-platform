/**
 * Archivos de las empresas: el disco (uploads/<empresa>/<archivo>) es caché y la
 * base guarda la copia (StoredFile). En Render (disco efímero, se borra en cada
 * despliegue) un archivo que falte se restaura desde la base al primer uso.
 *
 * FILE_STORE = db  → copia en la base (por defecto en producción)
 * FILE_STORE = disk → solo disco (desarrollo local)
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { basename, extname, join, resolve } from 'path';

export const UPLOADS_DIR = resolve(process.cwd(), 'uploads');
const MAX_DB_BYTES = 12 * 1024 * 1024; // Mongo admite 16 MB por documento

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', amr: 'audio/amr', mp4: 'video/mp4', pdf: 'application/pdf',
};

export function storeInDb(): boolean {
  const mode = (process.env.FILE_STORE ?? '').toLowerCase();
  if (mode === 'disk') return false;
  if (mode === 'db') return true;
  return process.env.NODE_ENV === 'production';
}

export function filePath(companyId: string, name: string): string {
  return join(UPLOADS_DIR, companyId, basename(name));
}

export function mimeOf(name: string): string {
  return MIME_BY_EXT[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/** Guarda en disco y (si aplica) copia en la base. */
export async function saveFile(prisma: any, companyId: string, name: string, buffer: Buffer, mime?: string) {
  const dir = join(UPLOADS_DIR, companyId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, basename(name)), buffer);
  await mirrorFile(prisma, companyId, name, buffer, mime);
}

export async function mirrorFile(prisma: any, companyId: string, name: string, buffer: Buffer, mime?: string) {
  if (!storeInDb() || buffer.length > MAX_DB_BYTES) return;
  const safe = basename(name);
  const data = { mime: mime ?? mimeOf(safe), size: buffer.length, data: buffer };
  const existing = await prisma.storedFile.findFirst({ where: { companyId, name: safe }, select: { id: true } });
  if (existing) await prisma.storedFile.update({ where: { id: existing.id }, data });
  else await prisma.storedFile.create({ data: { companyId, name: safe, ...data } });
}

/** Asegura que el archivo esté en disco (lo baja de la base si el disco se borró). */
export async function ensureFile(prisma: any, companyId: string, name: string): Promise<string | null> {
  const path = filePath(companyId, name);
  if (existsSync(path)) return path;
  if (!storeInDb()) return null;
  const row = await prisma.storedFile.findFirst({ where: { companyId, name: basename(name) } });
  if (!row?.data) return null;
  mkdirSync(join(UPLOADS_DIR, companyId), { recursive: true });
  writeFileSync(path, Buffer.from(row.data));
  return path;
}

export async function removeFile(prisma: any, companyId: string, name: string | null | undefined) {
  if (!name) return;
  try {
    unlinkSync(filePath(companyId, name));
  } catch {
    /* ya no estaba en disco */
  }
  if (storeInDb()) await prisma.storedFile.deleteMany({ where: { companyId, name: basename(name) } });
}

/** Sube a la base los archivos que solo estaban en disco (migración antes del primer despliegue). */
export async function backfillFromDisk(prisma: any, companyIds: string[]) {
  let copied = 0;
  for (const companyId of companyIds) {
    const dir = join(UPLOADS_DIR, companyId);
    if (!existsSync(dir)) continue;
    for (const name of require('fs').readdirSync(dir) as string[]) {
      const buffer = readFileSync(join(dir, name));
      if (buffer.length > MAX_DB_BYTES) continue;
      const exists = await prisma.storedFile.findFirst({ where: { companyId, name }, select: { id: true } });
      if (exists) continue;
      await prisma.storedFile.create({ data: { companyId, name, mime: mimeOf(name), size: buffer.length, data: buffer } });
      copied++;
    }
  }
  return copied;
}
