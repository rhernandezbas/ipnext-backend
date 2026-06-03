-- CreateTable
CREATE TABLE "DeviceTypeCatalog" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceTypeCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceTypeCatalog_name_key" ON "DeviceTypeCatalog"("name");

-- Seed: 5 base device types (idempotent — safe to replay)
INSERT INTO "DeviceTypeCatalog" ("id","name","active","sortOrder","createdAt","updatedAt")
VALUES
  (gen_random_uuid(),'ONU',    true, 0, now(), now()),
  (gen_random_uuid(),'ROUTER', true, 1, now(), now()),
  (gen_random_uuid(),'ANTENA', true, 2, now(), now()),
  (gen_random_uuid(),'REPETIDOR',true,3, now(), now()),
  (gen_random_uuid(),'OTROS',  true, 4, now(), now())
ON CONFLICT (name) DO NOTHING;
