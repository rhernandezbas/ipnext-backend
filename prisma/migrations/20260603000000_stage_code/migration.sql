-- Migration: 20260603000000_stage_code
-- Adds the immutable `code` field to Stage (business identity, rename-safe slug).
-- Three-step approach within a single migration (atomic): ADD nullable -> backfill -> SET NOT NULL + unique index.
-- Apply in prod with: npx prisma migrate deploy (NEVER migrate dev)

-- 1. Add nullable column (backfill-safe)
ALTER TABLE "Stage" ADD COLUMN "code" TEXT;

-- 2. Backfill deterministico e idempotente.
--    (a) Mapear los 11 canonicos por LOWER(name) -> code de negocio.
--    (b) Para cualquier otro stage: slug del name (lower, sin acentos, no-alnum -> '_').
--    (c) Desambiguar colisiones dentro del MISMO workflow con sufijo numerico.
--    Idempotente: solo toca filas con "code" IS NULL (re-run no pisa).
DO $$
DECLARE
  r RECORD;
  base_code TEXT;
  candidate TEXT;
  n INT;
BEGIN
  -- (a)+(b) primer pase: asignar base_code a todo stage sin code
  FOR r IN SELECT "id", "workflowId", "name" FROM "Stage" WHERE "code" IS NULL LOOP
    base_code := CASE LOWER(TRIM(r."name"))
      WHEN 'nuevo'                THEN 'nuevo'
      WHEN 'confirmado'           THEN 'confirmado'
      WHEN 'pospuesta'            THEN 'pospuesta'
      WHEN 'no factible'          THEN 'no_factible'
      WHEN 'enviar a iclass'      THEN 'send_to_iclass'
      WHEN 'registrado en iclass' THEN 'registered_in_iclass'
      WHEN 'notificado'           THEN 'notificado'
      WHEN 'en progreso'          THEN 'en_progreso'
      WHEN 'instalado'            THEN 'instalado'
      WHEN 'hecho'                THEN 'hecho'
      WHEN 'anulado-cancelado'    THEN 'anulado_cancelado'
      ELSE
        -- slug fallback: unaccent + lower + collapse non-alnum -> '_'
        TRIM(BOTH '_' FROM REGEXP_REPLACE(
          LOWER(TRANSLATE(r."name",
            'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
            'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC')),
          '[^a-z0-9]+', '_', 'g'))
    END;
    IF base_code IS NULL OR base_code = '' THEN
      base_code := 'stage';
    END IF;

    -- (c) desambiguar dentro del workflow
    candidate := base_code;
    n := 1;
    WHILE EXISTS (
      SELECT 1 FROM "Stage" s
      WHERE s."workflowId" = r."workflowId"
        AND s."code" = candidate
        AND s."id" <> r."id"
    ) LOOP
      n := n + 1;
      candidate := base_code || '_' || n::TEXT;
    END LOOP;

    UPDATE "Stage" SET "code" = candidate WHERE "id" = r."id";
  END LOOP;
END $$;

-- 3. Enforce: NOT NULL + unique por workflow
ALTER TABLE "Stage" ALTER COLUMN "code" SET NOT NULL;
CREATE UNIQUE INDEX "Stage_workflowId_code_key" ON "Stage"("workflowId", "code");
