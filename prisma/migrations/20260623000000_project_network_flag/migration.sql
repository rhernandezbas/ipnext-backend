-- Migration: project_network_flag (#40)
-- Adds isNetworkProject flag to Project.
-- Additive (DEFAULT false) — no backfill needed; existing projects default to false.
-- ADD COLUMN ... DEFAULT is metadata-only in PG (instantaneous on live tables).

ALTER TABLE "Project"
  ADD COLUMN IF NOT EXISTS "isNetworkProject" BOOLEAN NOT NULL DEFAULT false;
