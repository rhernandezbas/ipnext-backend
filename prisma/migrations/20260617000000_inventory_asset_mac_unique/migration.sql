-- FIX 3 (depot-stock-entry adversarial review): InventoryAsset.mac partial unique index.
-- mac is nullable (operators may not always know the MAC); NULLs must remain free so
-- MAC-unknown entries don't collide. A partial unique enforces uniqueness ONLY on
-- non-null values, matching the "one device, one MAC" business rule.
--
-- Pattern mirrors InventoryMovement.sourceRef partial unique (20260612000000_iclass_returns):
-- hand-authored partial index, mac stays String? WITHOUT @unique in schema.prisma
-- (Prisma cannot express WHERE clauses; a full @@unique would index NULLs and collide).
--
-- DO-NOT-CHURN: do not add @@unique([mac]) to schema.prisma or `prisma migrate` will
-- try to replace this partial index with a full one, breaking null-safe semantics.
-- Keep the column plain in schema.prisma + the comment pointing here.
--
-- Idempotent: IF NOT EXISTS guards re-runs (e.g. migrate reset + migrate deploy).

CREATE UNIQUE INDEX IF NOT EXISTS "InventoryAsset_mac_key"
  ON "InventoryAsset"("mac")
  WHERE "mac" IS NOT NULL;
