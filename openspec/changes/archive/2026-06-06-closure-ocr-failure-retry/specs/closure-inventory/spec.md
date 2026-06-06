# Spec delta — closure-ocr-failure-retry (#22)

Capability: OCR de fotos de equipos en el closure → sugerencias de inventario (gating del re-OCR ante fallos técnicos).

## ADDED Requirements

### Requirement: REQ-OCR-FAIL-1 — Un fallo técnico de OCR no se persiste ni cachea
Cuando el OCR de una foto falla por una causa técnica (LLM caída, timeout, descarga fallida), la extracción NO se persiste — para que un reintento posterior vuelva a llamar al modelo.

#### Scenario: fallo técnico → no persiste, señaliza
- **WHEN** `ExtractDeviceInfoFromPhoto.execute` recibe del OCR un resultado marcado como fallo técnico (`failed`)
- **THEN** NO guarda la extracción y retorna `null` (la idempotencia por `photoUrl` no queda envenenada con un cache fallido).

#### Scenario: lectura legible o ilegible-no-técnica → persiste
- **WHEN** el modelo corre y devuelve un resultado (con o sin SN/MAC, pero sin fallo técnico)
- **THEN** la extracción se persiste como hoy y se retorna.

### Requirement: REQ-OCR-FAIL-2 — `inventoryBuilt` solo si no hubo fallo técnico
El inventario se marca como construido SOLO cuando ninguna foto del cierre falló técnicamente; con un fallo, queda pendiente para el reprocess.

#### Scenario: fallo técnico en alguna foto → queda pendiente
- **WHEN** al menos una foto device dio fallo técnico durante `runClosureSideEffects`
- **THEN** NO se marca `inventoryBuilt=true` → el reprocess existente vuelve a correr el inventory (re-OCR de las fallidas; las legibles ya creadas se re-upsertean sin duplicar).

#### Scenario: sin fallos técnicos → se marca
- **WHEN** ninguna foto falló técnicamente
- **THEN** `inventoryBuilt=true` (comportamiento actual).

### Requirement: REQ-OCR-FAIL-3 — Label ilegible se mantiene (no se reintenta)
Una foto cuyo modelo corrió pero no leyó SN/MAC (label ilegible) NO es un fallo técnico: se mantiene su sugerencia DEVICE (con foto, SN null) y NO se reintenta (re-OCR sería en vano).

#### Scenario: ilegible → DEVICE con foto, sin reintento
- **WHEN** el OCR corre y devuelve SN=null y MAC=null sin fallo técnico
- **THEN** se crea/mantiene el DEVICE con la foto (para completar a mano vía #19), y `inventoryBuilt` puede marcarse `true`.

### Requirement: REQ-OCR-FAIL-4 — Remediación de datos históricos
Una migración idempotente repara los inventory mal marcados durante la caída de la LLM, para que el reprocess existente los retome.

#### Scenario: destilda + limpia, re-OCR vía reprocess
- **WHEN** corre la migración de remediación
- **THEN** (a) pone `inventoryBuilt=false` en las OS con extracciones `ocr-error`, (b) borra los DEVICE pending incompletos (source OCR, sin SN ni MAC) de esas tasks — porque la natural key del upsert `(taskId,kind,sn,mac,materialDesc)` haría que el re-OCR cree un duplicado en vez de actualizar, (c) borra las extracciones `ocr-error` cacheadas. Re-aplicarla no rompe (los predicados ya no matchean).

## Out of scope
- Validación al confirmar sin SN/MAC (#18).
- Alta/edición manual de SN en la sugerencia (#19).
- Cambiar el modelo o el preprocesado del OCR.
