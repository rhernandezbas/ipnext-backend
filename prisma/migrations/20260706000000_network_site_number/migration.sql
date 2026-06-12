-- network-site-fixed-code (#51): siteNumber estable por sitio vía secuencia dedicada.
-- Aditiva e idempotente. Sin BEGIN/COMMIT (Prisma envuelve la migración).

-- 1. Secuencia dedicada (idempotente).
CREATE SEQUENCE IF NOT EXISTS network_site_number_seq;

-- 2. Columna nullable primero (para poder backfillear antes del NOT NULL).
ALTER TABLE "NetworkSite" ADD COLUMN IF NOT EXISTS "siteNumber" INTEGER;

-- 3. Backfill idempotente con guard: solo numera filas sin siteNumber, en orden
--    estable (createdAt, id). Re-correr NO re-numera lo ya numerado.
WITH numbered AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, id ASC) AS rn
  FROM "NetworkSite"
  WHERE "siteNumber" IS NULL
)
UPDATE "NetworkSite" ns
SET "siteNumber" = numbered.rn
FROM numbered
WHERE ns.id = numbered.id;

-- 4. Avanzar la secuencia más allá del mayor siteNumber asignado, para que el
--    próximo nextval() no colisione con el backfill.
SELECT setval(
  'network_site_number_seq',
  GREATEST((SELECT COALESCE(MAX("siteNumber"), 0) FROM "NetworkSite"), 1),
  (SELECT COUNT(*) FROM "NetworkSite") > 0
);

-- 5. Default = nextval para inserts futuros.
ALTER TABLE "NetworkSite" ALTER COLUMN "siteNumber" SET DEFAULT nextval('network_site_number_seq');

-- 6. NOT NULL (ya backfilleado) + UNIQUE.
ALTER TABLE "NetworkSite" ALTER COLUMN "siteNumber" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'NetworkSite_siteNumber_key'
  ) THEN
    ALTER TABLE "NetworkSite" ADD CONSTRAINT "NetworkSite_siteNumber_key" UNIQUE ("siteNumber");
  END IF;
END $$;
