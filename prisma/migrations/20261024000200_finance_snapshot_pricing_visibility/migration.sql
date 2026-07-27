-- finance-growth-dashboard Fase 3 REWORK (2026-07-27) — "DOS NÚMEROS, DOS
-- PREGUNTAS": MRR contratado (bridge) + cobranza real (cash, sin bridge) +
-- tasa de cobranza, con visibilidad explícita de contratos sin precio
-- resoluble (F2) y churn de ingresos "no sé" vs "0%" (F4). 100% ADITIVA:
-- solo agrega columnas nuevas (con default) y un índice compuesto sobre una
-- tabla existente; ninguna columna se borra. Sin BEGIN/COMMIT (Prisma
-- envuelve cada migración en su propia transacción).

-- AlterTable: FinanceMonthlySnapshot — visibilidad de precio sin resolver (F2)
ALTER TABLE "FinanceMonthlySnapshot" ADD COLUMN "unpricedContractsActive" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "FinanceMonthlySnapshot" ADD COLUMN "unpricedContractsPct" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "FinanceMonthlySnapshot" ADD COLUMN "unpricedPlanChangeEvents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: FinanceMonthlySnapshot — tasa de cobranza (cobranza / MRR contratado), nullable (sin base = null, nunca "0% cobrado")
ALTER TABLE "FinanceMonthlySnapshot" ADD COLUMN "collectionRatePct" DECIMAL(9,2);

-- AlterTable: FinanceMonthlySnapshot — churnRevenuePct pasa a nullable (F4: null = "no había base", nunca "0% churn" por defecto silencioso)
ALTER TABLE "FinanceMonthlySnapshot" ALTER COLUMN "churnRevenuePct" DROP NOT NULL;

-- CreateIndex: FinancePaymentReceipt — índice compuesto para el filtro (clientGrId, fechaRecibo) de la atribución Capa B (J2)
CREATE INDEX "FinancePaymentReceipt_clientGrId_fechaRecibo_idx" ON "FinancePaymentReceipt"("clientGrId", "fechaRecibo");
