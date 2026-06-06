# Tasks — closure-ocr-failure-retry (#22)

Strict TDD (red→green). Solo BE. Deploy con verify completo (regla de oro).

## Backend (ipnext-backend)

- [ ] **1. Señal `failed` en el port + adapter**
  - `domain/ports/DevicePhotoOcr.ts`: `DeviceOcrResult` suma `failed?: boolean`.
  - `infrastructure/adapters/ocr/OllamaDevicePhotoOcr.ts`: el `catch` devuelve `failed: true` (mantiene `rawOutput: 'ocr-error: …'`).
  - (Sin test propio — se cubre vía los use-cases; tsc valida el tipo.)

- [ ] **2. RED+GREEN — `ExtractDeviceInfoFromPhoto` no persiste el fallo técnico** (`src/__tests__/application/ExtractDeviceInfoFromPhoto.test.ts`)
  - RED: (a) OCR con `failed:true` → `execute` retorna `null` y `repo.findByPhotoUrl` sigue vacío (NO persistió); (b) ilegible (`failed` ausente, sn/mac null) → persiste y retorna; (c) los tests actuales siguen verdes.
  - GREEN: `ExtractDeviceInfoFromPhoto.execute` → `Promise<OcrExtraction | null>`; `if (result.failed) return null;` antes de persistir.

- [ ] **3. RED+GREEN — `runClosureSideEffects` gatea `inventoryBuilt`** (`src/__tests__/application/IngestClosedServiceOrders.test.ts`)
  - RED: (a) una foto con OCR `failed` → `inventoryBuilt` NO se marca (queda pendiente); (b) sin fallos → se marca; (c) reprocess re-OCR-ea (OCR stub: `failed` la 1ª vez, SN la 2ª) → ahora marca built y la sugerencia tiene SN.
  - GREEN: el OCR loop omite las extracciones `null` y setea `ocrFailed`; `markSideEffect('inventoryBuilt')` solo si `!ocrFailed`. El `catch` del loop también setea `ocrFailed`.

- [ ] **4. Migración de remediación** (`prisma/migrations/<ts>_remediate_ocr_failed_inventory/migration.sql`, ts > `20260606000000`)
  - 3 statements (UPDATE `inventoryBuilt=false` → DELETE suggestions incompletos → DELETE extracciones `ocr-error`), join `iclassId::text = serviceOrderId` y `sourceTaskId = taskId`.
  - **Confirmar nombres exactos de columna** (`serialNumber`, `mac`, `source`, `status`) leyendo el schema antes de escribir el SQL.
  - **Mostrar el SQL al usuario antes de pushear** (regla de migraciones).

- [ ] **5. Verify BE** — `tsc --noEmit` (exit 0) + `npx jest --runInBand` (verde). Recién entonces commit + deploy (OK del usuario) + confirmar run en `gh` (incluido el step de migraciones).

## Cierre

- [ ] **6. Archive + docs** — `sdd-archive` (mover change a `archive/`). Commit del `BACKLOG.md`: #22 → hecho.
- [ ] **7. Reprocess en prod** — tras el deploy, correr "Reprocesar" para que re-OCR-ee los inventory destildados por la migración (con la LLM arriba).
