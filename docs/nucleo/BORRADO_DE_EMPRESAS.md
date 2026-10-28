# Borrado de empresas · diagnóstico y plan de retención

Estado: Fase 1 (octubre 2026). **No se cambió el comportamiento del borrado.** Solo se añadió una vista de solo lectura.

## 1. Cómo funciona hoy
`DELETE /companies/:id` (solo plataforma) hace dos cosas:
1. `deleteCompanyLooseData` borra las colecciones con `companyId` suelto (sin relación Prisma).
2. `prisma.company.delete` dispara los `onDelete: Cascade` de las relaciones.

La clasificación completa, por modelo, está en `apps/api/src/common/company-cleanup.ts`:

| Grupo | Qué pasa | Ejemplos |
|---|---|---|
| `CASCADE_MODELS` | se borra por relación | usuarios, contactos, conversaciones, **facturas, pagos, registro de auditoría** |
| `CLEANED_MODELS` | lo borra la limpieza manual | colecciones con `companyId` sin relación |
| `ORPHANED_MODELS` | **queda huérfano** (nadie lo borra) | 31 modelos: Ads (`adAccount`, `adInsightDaily`…), Creative (`creativeWallet`, `brandAsset`…), `storedFile`, `receivable`, `calendarConnection`, `authToken`… |
| `SET_NULL_MODELS` | se conserva sin empresa | `emailMessage` |

Una prueba (`nucleo.spec.ts`, bloque E) verifica que todo modelo con `companyId` del schema esté clasificado: si alguien agrega un modelo y no lo clasifica, la prueba falla.

## 2. Problemas
1. **Retención:** el cascade borra facturas, pagos y la auditoría. Eso choca con obligaciones contables/fiscales y deja sin rastro quién hizo qué.
2. **Huérfanos:** 31 modelos quedan con un `companyId` inexistente. El más delicado es `calendarConnection`, que conserva el token OAuth cifrado de Google de una empresa que ya no existe; también `storedFile` (archivos) y `adAccount`. Además ocupan espacio, pueden reaparecer si se reusa un id —improbable con ObjectId— y complican reportes.
3. **Irreversible:** no hay periodo de gracia ni respaldo previo.

## 3. Ver el impacto antes de borrar (nuevo, solo lectura)
`GET /companies/:id/data-footprint` (SUPER_ADMIN/DEV) devuelve, sin modificar nada:
- `deletedByCascade`, `deletedByCleanup`, `wouldBeOrphaned`, `keptWithoutCompany`: conteos por modelo.
- `totals` y `warnings` (avisa si hay facturas/pagos, auditoría o huérfanos).

## 4. Plan propuesto (requiere aprobación; nada de esto está implementado)
1. **Baja lógica primero:** `DELETE` pasa a marcar `status = 'DELETED'` + `deletedAt`, desactiva usuarios, revoca tokens e invitaciones y apaga canales/bots. La empresa desaparece de la operación pero los datos siguen.
2. **Periodo de gracia** (p. ej. 30 días) durante el cual la plataforma puede restaurar.
3. **Purga programada** al vencer la gracia, con respaldo exportado previo:
   - Datos operativos (contactos, conversaciones, media…): se borran.
   - Facturas y pagos: se **conservan** desvinculados (cambiar a `SetNull`/copia a una colección de archivo) durante el plazo legal que defina el negocio.
   - Auditoría: se conserva (append-only) con el nombre de la empresa en el detalle.
   - Huérfanos: se suman a la limpieza.
4. Cambiar el `onDelete` de `Invoice`, `Payment` y `AuditLog` exige `db push`; en Mongo no altera índices de datos, pero se hace primero en la base del piloto y luego con aprobación en producción.

## 5. Decisiones pendientes
- Plazo de retención de facturas/pagos y auditoría.
- Duración del periodo de gracia.
- Si el cliente puede pedir el borrado él mismo o solo la plataforma.
