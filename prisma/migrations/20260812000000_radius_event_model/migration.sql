-- CreateTable
CREATE TABLE "RadiusEvent" (
    "id" TEXT NOT NULL,
    "sourceUniqueId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "nasIpAddress" TEXT NOT NULL,
    "nasId" TEXT,
    "framedIp" TEXT,
    "macAddress" TEXT,
    "vlanId" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "stoppedAt" TIMESTAMP(3),
    "sessionTime" INTEGER,
    "bytesIn" BIGINT NOT NULL DEFAULT 0,
    "bytesOut" BIGINT NOT NULL DEFAULT 0,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RadiusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RadiusEvent_sourceUniqueId_key" ON "RadiusEvent"("sourceUniqueId");

-- CreateIndex
CREATE INDEX "RadiusEvent_username_idx" ON "RadiusEvent"("username");

-- CreateIndex
CREATE INDEX "RadiusEvent_nasId_idx" ON "RadiusEvent"("nasId");

-- CreateIndex
CREATE INDEX "RadiusEvent_nasIpAddress_idx" ON "RadiusEvent"("nasIpAddress");

-- CreateIndex
CREATE INDEX "RadiusEvent_vlanId_idx" ON "RadiusEvent"("vlanId");

-- CreateIndex
CREATE INDEX "RadiusEvent_startedAt_idx" ON "RadiusEvent"("startedAt");

-- CreateIndex
CREATE INDEX "RadiusEvent_stoppedAt_idx" ON "RadiusEvent"("stoppedAt");

-- CreateIndex
CREATE INDEX "RadiusEvent_status_idx" ON "RadiusEvent"("status");

-- CreateIndex
CREATE INDEX "RadiusEvent_username_startedAt_idx" ON "RadiusEvent"("username", "startedAt");

-- AddForeignKey
ALTER TABLE "RadiusEvent" ADD CONSTRAINT "RadiusEvent_nasId_fkey" FOREIGN KEY ("nasId") REFERENCES "NasServer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
