-- Migration: 20260805000000_zone_model
-- CreateTable Zone: visual polygon zones for the customer map (customer-zones-map).
-- `points` is JSONB — stores an ordered array of { lat, lng } vertices.
-- Additive: zero changes to existing tables.

-- CreateTable
CREATE TABLE "Zone" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "points" JSONB NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);
