-- actions-worklist (EPIC titularidad F2): casos de cambio de titularidad detectados
-- desde el mirror GR. Aditiva (tabla nueva + índices) → segura, sin backfill, sin
-- transacción manual. Sin FKs a Contract/Client (registro operativo, ids del mirror).

-- CreateTable
CREATE TABLE "OwnershipTransferCase" (
    "id" TEXT NOT NULL,
    "sourceContractId" TEXT NOT NULL,
    "sourceClientId" TEXT NOT NULL,
    "motivoBaja" TEXT NOT NULL,
    "bajaDate" TEXT,
    "targetContractId" TEXT,
    "targetClientId" TEXT,
    "candidates" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "dismissReason" TEXT,
    "equipmentReviewed" BOOLEAN NOT NULL DEFAULT false,
    "equipmentReviewedById" TEXT,
    "equipmentReviewedAt" TIMESTAMP(3),
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnershipTransferCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnershipTransferCase_sourceContractId_key" ON "OwnershipTransferCase"("sourceContractId");

-- CreateIndex
CREATE INDEX "OwnershipTransferCase_status_idx" ON "OwnershipTransferCase"("status");

-- CreateIndex
CREATE INDEX "OwnershipTransferCase_targetClientId_idx" ON "OwnershipTransferCase"("targetClientId");
