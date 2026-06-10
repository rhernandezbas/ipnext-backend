-- Migration: project_retirement_flag
-- Adds allowsEquipmentRetirement flag to Project.
-- Additive (DEFAULT false) — no backfill needed; existing projects default to false.
-- ADD COLUMN ... DEFAULT is metadata-only in PG (instantaneous on live tables).

ALTER TABLE "Project"
  ADD COLUMN IF NOT EXISTS "allowsEquipmentRetirement" BOOLEAN NOT NULL DEFAULT false;
