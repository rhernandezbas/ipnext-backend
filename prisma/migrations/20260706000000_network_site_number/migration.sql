-- network-site-fixed-code (#51): siteNumber estable por sitio vía secuencia dedicada.
-- Alineada al precedente probado 20260514100000_add_task_sequence_number:
--   secuencia con naming serial de Prisma ("NetworkSite_siteNumber_seq"),
--   OWNED BY la columna, y schema con @default(autoincrement()) — así NO hay drift
--   Prisma↔SQL (autoincrement mapea exactamente a este naming/ownership).
-- Aditiva e idempotente (guards) para soportar re-corrida en estado mixto.
-- Sin BEGIN/COMMIT (Prisma envuelve la migración).

-- 1. Columna nullable primero (para poder backfillear antes del NOT NULL).
ALTER TABLE "NetworkSite" ADD COLUMN IF NOT EXISTS "siteNumber" INTEGER;

-- 2. Backfill idempotente con offset. Solo numera filas sin siteNumber, en orden
--    estable (createdAt, id). El offset `+ COALESCE(MAX(siteNumber),0)` arranca por
--    encima de lo ya numerado, así una re-corrida en estado mixto NO colisiona ni
--    re-numera lo existente (idempotencia real).
WITH numbered AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, id ASC)
           + COALESCE((SELECT MAX("siteNumber") FROM "NetworkSite"), 0) AS rn
  FROM "NetworkSite"
  WHERE "siteNumber" IS NULL
)
UPDATE "NetworkSite" ns
SET "siteNumber" = numbered.rn
FROM numbered
WHERE ns.id = numbered.id;

-- 3. Secuencia con naming serial de Prisma + OWNED BY (cleanup en cascada con la
--    columna). Igual que "ScheduledTask_sequenceNumber_seq".
CREATE SEQUENCE IF NOT EXISTS "NetworkSite_siteNumber_seq" OWNED BY "NetworkSite"."siteNumber";

-- 4. Posicionar la secuencia tras el mayor siteNumber asignado, para que el próximo
--    nextval() no colisione con el backfill.
SELECT setval(
  '"NetworkSite_siteNumber_seq"',
  COALESCE((SELECT MAX("siteNumber") FROM "NetworkSite"), 0) + 1,
  false
);

-- 5. Default = nextval + NOT NULL (ya backfilleado).
ALTER TABLE "NetworkSite"
  ALTER COLUMN "siteNumber" SET DEFAULT nextval('"NetworkSite_siteNumber_seq"'),
  ALTER COLUMN "siteNumber" SET NOT NULL;

-- 6. UNIQUE como CREATE UNIQUE INDEX, igual que el precedente (naming "_key").
CREATE UNIQUE INDEX IF NOT EXISTS "NetworkSite_siteNumber_key" ON "NetworkSite"("siteNumber");
