-- Seed the canonical ticket statuses (idempotent).
-- The deploy pipeline runs `prisma migrate deploy` but NOT `prisma db seed`, so the
-- TicketStatusCatalog must be bootstrapped via migration to exist in every environment.
-- Mirrors the TaskPriority bootstrap pattern (ON CONFLICT (name) DO NOTHING, never
-- ON CONFLICT ON CONSTRAINT). Re-runnable: existing rows (by name) are left untouched,
-- so manual edits to colour/weight from the admin UI are preserved.
INSERT INTO "TicketStatusCatalog" ("id", "name", "color", "weight", "createdAt", "updatedAt") VALUES
  ('c5a70001-0000-4000-8000-000000000001', 'open',    '#22c55e', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('c5a70002-0000-4000-8000-000000000002', 'pending', '#f59e0b', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('c5a70003-0000-4000-8000-000000000003', 'closed',  '#94a3b8', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
