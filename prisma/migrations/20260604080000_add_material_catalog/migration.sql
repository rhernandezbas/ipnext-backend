-- CreateTable
CREATE TABLE "MaterialCatalog" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT,
    "unit" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MaterialCatalog_name_key" ON "MaterialCatalog"("name");

-- Seed: materiales base (idempotent — safe to replay)
INSERT INTO "MaterialCatalog" ("id","name","unit","active","sortOrder","createdAt","updatedAt")
VALUES
  (gen_random_uuid(),'CABLE_UTP',     'm',      true, 0, now(), now()),
  (gen_random_uuid(),'CABLE_FIBRA',   'm',      true, 1, now(), now()),
  (gen_random_uuid(),'CONECTOR_RJ45', 'unidad', true, 2, now(), now()),
  (gen_random_uuid(),'CONECTOR_FIBRA','unidad', true, 3, now(), now()),
  (gen_random_uuid(),'PRECINTO',      'unidad', true, 4, now(), now()),
  (gen_random_uuid(),'ROSETA',        'unidad', true, 5, now(), now()),
  (gen_random_uuid(),'OTRO',          'unidad', true, 6, now(), now())
ON CONFLICT (name) DO NOTHING;
