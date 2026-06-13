-- #86 — ScheduledTask archive flag. Aditivo puro; no toca filas existentes.
-- No BEGIN/COMMIT (Prisma envuelve cada migración en su propia transacción).

-- AlterTable
ALTER TABLE "ScheduledTask" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ScheduledTask_archivedAt_idx" ON "ScheduledTask"("archivedAt");
