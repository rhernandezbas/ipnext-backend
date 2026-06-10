-- ============================================================================
-- Seed the missing `iclass-inventory-returns` feature flag (EPIC #38 W4 fix)
--
-- The W4 migration (20260612000000_iclass_returns) gated the returns staging
-- behind this flag but never seeded the row. The runtime gate tolerated the
-- absence (missing row == disabled), but the UI toggle (Automatizaciones tab,
-- FE PR #65) PATCHes via SetFeatureFlag, which requires the row to exist —
-- toggling failed with FeatureFlagNotFoundError.
--
-- Data-only, idempotent (same pattern as the W6 seed in
-- 20260613000000_inventory_material_deduction). Default OFF.
-- ============================================================================

INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
    VALUES ('iclass-inventory-returns', false, NOW())
    ON CONFLICT ("key") DO NOTHING;
