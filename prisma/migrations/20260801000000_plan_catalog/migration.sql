-- Migration: 20260801000000_plan_catalog
-- CreateTable Plan: catálogo de planes de velocidad (Fase 1, sin integración RADIUS).

CREATE TABLE "Plan" (
    "id"           TEXT NOT NULL,
    "code"         TEXT NOT NULL,
    "name"         TEXT NOT NULL,
    "category"     TEXT NOT NULL,
    "downloadKbps" INTEGER NOT NULL,
    "uploadKbps"   INTEGER NOT NULL,
    "status"       TEXT NOT NULL DEFAULT 'enabled',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");
CREATE INDEX "Plan_status_category_idx" ON "Plan"("status", "category");
