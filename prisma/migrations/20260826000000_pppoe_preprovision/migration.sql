-- pppoe-preprovision-autoinstall (design D1/D2) — ADITIVA y segura:
--   1) PppoeService.nasId pasa a NULLABLE: nasId NULL = pre-provisión "pendiente de instalación"
--      (el usuario vive en el RADIUS central SIN Framed-IP; el watcher lo adopta al conectar).
--      El FK PppoeService_nasId_fkey NO se toca (sigue ON DELETE RESTRICT ON UPDATE CASCADE —
--      borrar un NAS con servicios sigue bloqueado; ver schema.prisma).
--   2) ipTypePreference ('cgnat' | 'public') NOT NULL DEFAULT 'cgnat' — las filas existentes
--      nacen 'cgnat' por el default, sin reescritura de tabla.
-- Generada con `prisma migrate diff` (schema viejo → nuevo). Sin BEGIN/COMMIT (Prisma envuelve
-- cada migración en su propia transacción).

-- AlterTable
ALTER TABLE "PppoeService" ADD COLUMN     "ipTypePreference" TEXT NOT NULL DEFAULT 'cgnat',
ALTER COLUMN "nasId" DROP NOT NULL;

-- Backfill best-effort e IDEMPOTENTE (design D2): filas cuya remoteAddress cae en el RANGO
-- [rangeStart..rangeEnd] de algún IpPool con ipKind='public' cargado → 'public'. El resto queda
-- 'cgnat' (default). Decisiones del cruce por rango en SQL:
--   · comparación por ::inet (orden correcto de IPv4; el compare de TEXT ordenaría mal '9.x' > '100.x');
--   · los casts van DENTRO de un CASE WHEN <regex IPv4 estricta> — CASE garantiza el orden de
--     evaluación (un WHERE plano puede reordenar predicados y castear basura antes del filtro);
--   · D6.9: la regex EXCLUYE octetos con cero a la izquierda ('100.064.1.1') — el ::inet de
--     PG moderno los RECHAZA con error (no los normaliza): una sola fila sucia crashearía el
--     deploy entero. Octeto = 25[0-5] | 2[0-4][0-9] | 1[0-9][0-9] | [1-9]?[0-9];
--   · un valor no-IPv4 (en la fila o en el pool) produce NULL → el BETWEEN da NULL → no matchea
--     (best-effort: jamás rompe el deploy);
--   · guard "ipTypePreference = 'cgnat'": re-correr la migración (o un pool cargado a posteriori)
--     nunca pisa un valor ya decidido — idempotente por construcción.
UPDATE "PppoeService" AS p
SET "ipTypePreference" = 'public'
WHERE p."ipTypePreference" = 'cgnat'
  AND p."remoteAddress" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "IpPool" AS pool
    WHERE pool."ipKind" = 'public'
      AND (CASE WHEN p."remoteAddress" ~ '^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$' THEN p."remoteAddress"::inet END)
          >= (CASE WHEN pool."rangeStart" ~ '^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$' THEN pool."rangeStart"::inet END)
      AND (CASE WHEN p."remoteAddress" ~ '^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$' THEN p."remoteAddress"::inet END)
          <= (CASE WHEN pool."rangeEnd" ~ '^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$' THEN pool."rangeEnd"::inet END)
  );
