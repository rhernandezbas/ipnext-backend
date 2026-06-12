-- #69 — Ticket Area Catalog: add `color` (hex) for the area pill in the tickets list.
-- Additive only. No BEGIN/COMMIT (Prisma wraps each migration in its own transaction).
-- Idempotent: IF NOT EXISTS on the column; seed colors are applied by area NAME
-- only to rows still on the default, so manual edits from the admin UI are preserved.

-- AddColumn (NOT NULL via DEFAULT so existing rows backfill automatically).
ALTER TABLE "TicketAreaCatalog" ADD COLUMN IF NOT EXISTS "color" TEXT NOT NULL DEFAULT '#6366f1';

-- Seed LLAMATIVE colors for the 3 default areas (#49), catalog-driven by name.
-- Only touch rows still carrying the column default so we never clobber a
-- color an operator already customized.
UPDATE "TicketAreaCatalog" SET "color" = '#6366f1' WHERE "name" = 'Soporte'        AND "color" = '#6366f1';
UPDATE "TicketAreaCatalog" SET "color" = '#f59e0b' WHERE "name" = 'Administración' AND "color" = '#6366f1';
UPDATE "TicketAreaCatalog" SET "color" = '#10b981' WHERE "name" = 'Facturación'    AND "color" = '#6366f1';
