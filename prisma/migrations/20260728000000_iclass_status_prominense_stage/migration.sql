-- iclass-intermediate-states — map an IClass OS status code to a Prominense Stage
-- (kanban column). When set, the scheduler auto-moves a matched task to this stage on a
-- status change (forward-only). Additive migration (ADD COLUMN + index + nullable FK).

-- AlterTable
ALTER TABLE "IClassStatusCatalog" ADD COLUMN     "prominenseStageId" TEXT;

-- CreateIndex
CREATE INDEX "IClassStatusCatalog_prominenseStageId_idx" ON "IClassStatusCatalog"("prominenseStageId");

-- AddForeignKey
ALTER TABLE "IClassStatusCatalog" ADD CONSTRAINT "IClassStatusCatalog_prominenseStageId_fkey" FOREIGN KEY ("prominenseStageId") REFERENCES "Stage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
