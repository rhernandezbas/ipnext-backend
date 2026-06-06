# Proposal — closure-ocr-failure-retry (#22)

Mode: interactive · Store: hybrid (openspec + engram `sdd/closure-ocr-failure-retry/*`).

## Why

Al cerrarse una OS, el closure corre OCR sobre las fotos de equipos para extraer SN/MAC y armar las sugerencias de inventario. Se vieron **varias tareas con la foto pero SIN SN** (DEVICE con `serialNumber=null`), coincidiendo con la **LLM (Ollama) caída** el 2026-06-05.

Causa raíz verificada (3 capas):
1. **`runClosureSideEffects`** marca `inventoryBuilt=true` siempre que `buildSuggestions` no lance — sin mirar si el OCR realmente extrajo algo. → el reprocess no reintenta.
2. **`BuildInventorySuggestions`** crea el DEVICE con `serialNumber: e.sn` aunque sea `null`. → la sugerencia "foto sin SN".
3. **`ExtractDeviceInfoFromPhoto` es idempotente por `photoUrl`**: cuando la LLM se cayó, persistió una extracción con `sn=null` y la **cachea**. En el reprocess devuelve ese cache fallido **sin volver a llamar al modelo** → el re-OCR nunca ocurre.

**Señal disponible**: el adapter `OllamaDevicePhotoOcr` ya distingue el **fallo técnico** (LLM caída / timeout / descarga fallida) devolviendo `rawOutput: 'ocr-error: …'` y `confidence: 0`. Cuando el modelo SÍ corre pero el label es ilegible, el `rawOutput` es el JSON del modelo (no `ocr-error:`). Esto permite reintentar **solo los fallos transitorios** sin loop infinito (el fallo técnico es transitorio por definición: cuando la LLM vuelve, deja de ser `ocr-error`).

## Decisiones (confirmadas con el usuario)

- **AD-1 — Scope acotado**: este change resuelve SOLO el bug del OCR. La validación al confirmar (#18) y el alta/edición manual de SN (#19) van como changes separados.
- **AD-2 — Distinguir fallo técnico vs label ilegible**:
  - **Fallo técnico** (`ocr-error`): NO se persiste/cachea la extracción, NO se crea el DEVICE de esa foto, NO se marca `inventoryBuilt`. → el reprocess re-OCR-ea esa foto.
  - **Label ilegible** (el modelo corrió, sin SN/MAC): se **mantiene** la foto/DEVICE (comportamiento actual) — el operador la completará a mano (#19) y la validación al confirmar la frenará si queda vacía (#18). `inventoryBuilt=true` (no se reintenta — re-OCR sería en vano).
- **AD-3 — Datos viejos**: una migración destilda los inventory mal marcados (los que tienen extracciones `ocr-error` cacheadas) y borra esas extracciones fallidas, para que el **reprocess existente** los re-OCR-ee. No se borran DEVICE: el upsert de `BuildInventorySuggestions` (idempotente por su natural key) los actualiza con el SN real al re-OCR.

## What changes (solo BE)

- **`ExtractDeviceInfoFromPhoto`**: si el resultado del OCR es un fallo técnico (`rawOutput` empieza con `ocr-error:`), NO persistir la extracción y señalar el fallo al caller (retorno `null`). Las lecturas legibles e ilegibles-no-técnicas se persisten como hoy.
- **`runClosureSideEffects` (IngestClosedServiceOrders)**: el OCR loop omite las extracciones fallidas (null) y marca un flag local; `inventoryBuilt` se marca `true` SOLO si NO hubo ningún fallo técnico. Con fallo → queda pendiente → reprocess.
- **Migración de remediación** (idempotente): borra `OcrExtraction` con `rawOutput LIKE 'ocr-error:%'` y pone `inventoryBuilt=false` en el side-effect state de las OS afectadas, para que el reprocess existente las retome.

## Impact

- **Out of scope**: validación al confirmar (#18), alta/edición manual de SN (#19), cambiar el modelo/preprocesado del OCR.
- **Riesgo**: bajo-medio. El comportamiento nuevo solo cambia el caso de fallo técnico; el camino feliz (OCR legible) queda igual. La migración de remediación es aditiva en efecto (borra solo extracciones marcadas `ocr-error` y destilda flags) — revisar el SQL antes de pushear.
- **Idempotencia**: `BuildInventorySuggestions` ya hace upsert por natural key → el re-OCR no duplica, actualiza.
- **Sin cambio de API ni de DTO**; FE no se toca en este change.

## A verificar en apply (riesgos técnicos)
- Otros call-sites de `ExtractDeviceInfoFromPhoto.execute` (¿endpoint manual de OCR?) que deban manejar el nuevo `null`.
- La natural key del upsert de `BuildInventorySuggestions` (para confirmar que el re-OCR actualiza, no duplica).
- La relación `OcrExtraction.serviceOrderId` ↔ `ClosedServiceOrder.iclassId` para destildar el side-effect state correcto.
