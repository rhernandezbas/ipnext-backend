-- Remediation (#22): repair inventory side-effects polluted by OCR TECHNICAL
-- failures (Ollama down on 2026-06-05). Lets the existing reprocess re-OCR them
-- once the model is back. Idempotent: after step 3 the predicates match nothing.
-- Runs inside the migration transaction; the OcrExtraction delete is LAST so the
-- joins in steps 1-2 still see the failed rows.

-- 1. Un-mark inventoryBuilt for the OS whose OCR failed technically, so the
--    reprocess stops skipping them as "already built".
UPDATE "IClassServiceOrder" SET "inventoryBuilt" = false
WHERE "iclassId"::text IN (
  SELECT "serviceOrderId" FROM "OcrExtraction"
  WHERE "rawOutput" LIKE 'ocr-error:%' AND "serviceOrderId" IS NOT NULL
);

-- 2. Delete the incomplete DEVICE suggestions (no SN/MAC) created from those failed
--    reads. The upsert natural key (taskId,kind,serialNumber,mac,materialDesc) would
--    otherwise make the re-OCR create a DUPLICATE instead of updating the sn=null row.
--    Scoped to pending + OCR-sourced + empty — never touches confirmed/manual items.
DELETE FROM "TaskInventorySuggestion"
WHERE "taskId" IN (
  SELECT "sourceTaskId" FROM "OcrExtraction"
  WHERE "rawOutput" LIKE 'ocr-error:%' AND "sourceTaskId" IS NOT NULL
)
  AND "kind" = 'DEVICE' AND "source" = 'OCR' AND "status" = 'pending'
  AND "serialNumber" IS NULL AND "mac" IS NULL;

-- 3. Delete the cached failed extractions so ExtractDeviceInfoFromPhoto re-runs the
--    model on the next reprocess (it is idempotent by photoUrl — a cached failed row
--    would otherwise short-circuit the re-OCR).
DELETE FROM "OcrExtraction" WHERE "rawOutput" LIKE 'ocr-error:%';
