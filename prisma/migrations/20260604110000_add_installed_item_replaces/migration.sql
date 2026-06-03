-- AlterTable: add self-relation field (nullable, additive — no existing data affected)
ALTER TABLE "ContractInstalledItem" ADD COLUMN "replacesItemId" TEXT;

-- CreateIndex
CREATE INDEX "ContractInstalledItem_replacesItemId_idx" ON "ContractInstalledItem"("replacesItemId");

-- AddForeignKey: self-relation with SetNull on delete (safe: soft-retires never hard-delete)
ALTER TABLE "ContractInstalledItem" ADD CONSTRAINT "ContractInstalledItem_replacesItemId_fkey" FOREIGN KEY ("replacesItemId") REFERENCES "ContractInstalledItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
