# Design — closure-ocr-failure-retry (#22)

Solo BE. 3 piezas: señal explícita de fallo + gating en el use-case/orquestador + migración de remediación.

## 1. Señal explícita de fallo técnico (port, no string-matching)

Hoy el adapter señaliza el fallo técnico con `rawOutput: 'ocr-error: …'`. Hacer que el use-case (application) string-matchee ese prefijo lo acoplaría a un detalle del adapter (infra). En su lugar:

- **`DeviceOcrResult`** (`domain/ports/DevicePhotoOcr.ts`) suma `failed?: boolean` — opcional (no rompe stubs ni otros adapters).
- **`OllamaDevicePhotoOcr.extract`**: en el `catch` (download/timeout/Ollama down) devuelve `{ …, rawOutput: 'ocr-error: …', failed: true }`. Se mantiene el `rawOutput 'ocr-error:'` (forensics + lo usa la migración para datos históricos), y se agrega `failed: true`.
- Los stubs de test setean `failed` solo donde el caso lo requiera; `undefined` ⇒ falsy ⇒ no falla.

## 2. Gating en use-case + orquestador

- **`ExtractDeviceInfoFromPhoto.execute`** → retorna `OcrExtraction | null`:
  - Tras `const result = await this.ocr.extract(...)`: `if (result.failed) return null;` (antes de persistir). No se guarda → la idempotencia por `photoUrl` no queda envenenada → reintento re-OCR-ea.
  - El resto (cached check, persistir lectura legible/ilegible) igual.
  - **Único caller productivo**: `IngestClosedServiceOrders` (verificado: no hay endpoint manual de OCR). Tests a actualizar: `ExtractDeviceInfoFromPhoto.test.ts`, `IngestClosedServiceOrders.test.ts`.
- **`runClosureSideEffects`** (`IngestClosedServiceOrders`): el OCR loop pasa a:
  ```ts
  let ocrFailed = false;
  ...
  try {
    const ext = await this.extractOcr.execute({...});
    if (ext) extractions.push(ext); else ocrFailed = true; // fallo técnico → reintentar
  } catch { ocrFailed = true; }
  ...
  await this.buildSuggestions.execute({ taskId, extractions, materials });
  if (!ocrFailed) await this.closed.markSideEffect(order.iclassId, 'inventoryBuilt', true);
  ```
  Con `ocrFailed`, NO se marca → reprocess reintenta (buildSuggestions es idempotente por natural key; las legibles ya creadas se re-upsertean, las fallidas se re-OCR-ean).

## 3. Migración de remediación (idempotente)

Relaciones verificadas: `OcrExtraction.serviceOrderId` (String) = `IClassServiceOrder.iclassId` (BigInt) como texto; `OcrExtraction.sourceTaskId` = `TaskInventorySuggestion.taskId`. Natural key del upsert = `(taskId,kind,serialNumber,mac,materialDesc)` → un re-OCR con SN real NO actualiza el DEVICE viejo `sn=null` (crearía duplicado) → hay que borrar los incompletos.

`prisma/migrations/<ts>_remediate_ocr_failed_inventory/migration.sql` (ts > `20260606000000`), 3 statements en orden (la migración corre en una transacción; borrar las extracciones AL FINAL para no perder el join):
```sql
-- 1. destildar inventoryBuilt de las OS con extracciones de fallo técnico
UPDATE "IClassServiceOrder" SET "inventoryBuilt" = false
WHERE "iclassId"::text IN (
  SELECT "serviceOrderId" FROM "OcrExtraction"
  WHERE "rawOutput" LIKE 'ocr-error:%' AND "serviceOrderId" IS NOT NULL);

-- 2. borrar los DEVICE pending incompletos (la natural key impediría el update via upsert)
DELETE FROM "TaskInventorySuggestion"
WHERE "taskId" IN (
  SELECT "sourceTaskId" FROM "OcrExtraction"
  WHERE "rawOutput" LIKE 'ocr-error:%' AND "sourceTaskId" IS NOT NULL)
  AND "kind" = 'DEVICE' AND "source" = 'OCR' AND "status" = 'pending'
  AND "serialNumber" IS NULL AND "mac" IS NULL;

-- 3. borrar las extracciones de fallo técnico cacheadas (re-OCR las regenera)
DELETE FROM "OcrExtraction" WHERE "rawOutput" LIKE 'ocr-error:%';
```
Confirmar en apply los nombres exactos de columna (`serialNumber`, `mac`, `source`, `status`) en `TaskInventorySuggestion`. Aditiva en efecto (solo toca filas marcadas `ocr-error`). Revisar el SQL antes de pushear (regla de migraciones).

## Tests (TDD)
- `ExtractDeviceInfoFromPhoto.test.ts`: (a) `failed` → retorna `null` y NO persiste (repo.findByPhotoUrl sigue vacío); (b) ilegible (sin failed, sn/mac null) → persiste y retorna; (c) los tests actuales siguen verdes.
- `IngestClosedServiceOrders.test.ts`: (a) una foto con `failed` → `inventoryBuilt` NO se marca (queda pendiente); (b) sin fallos → se marca; (c) reprocess re-OCR-ea y, ahora con SN, marca built. Usar un OCR stub que devuelva `failed:true` la primera vez y un SN la segunda.

## Riesgos
- La migración borra suggestions: acotada a `pending` + `source='OCR'` + sin SN/MAC + tasks con extracción `ocr-error`. No toca confirmadas ni manuales. Revisar el SQL con el usuario antes de pushear.
- El flag `failed` es opcional → no rompe el contrato del port ni otros adapters/tests.
