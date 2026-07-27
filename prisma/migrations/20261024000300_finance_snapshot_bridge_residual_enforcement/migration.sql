-- finance-growth-dashboard fix-wave-3 (re-review con aritmética verificada,
-- 2026-07-27) — dos columnas nuevas en FinanceMonthlySnapshot. 100% ADITIVA:
-- solo agrega columnas con DEFAULT; ninguna columna se borra ni se altera.
-- Sin BEGIN/COMMIT (Prisma envuelve cada migración en su propia transacción).

-- AlterTable: FinanceMonthlySnapshot — bridgeResidualArs (🟡 4): mrrFinal -
-- (mrrInicial+new+upgrade-downgrade-churn). 0 en el caso sano; hace VISIBLE
-- cualquier hueco del bridge en vez de dejarlo pasar en silencio.
ALTER TABLE "FinanceMonthlySnapshot" ADD COLUMN "bridgeResidualArs" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable: FinanceMonthlySnapshot — enforcementPlanChangeEventsExcluded
-- (🔴 1): eventos 'modified' del mes donde el plan viejo o nuevo es un
-- código de ENFORCEMENT (IP-REDUCCION/IP-BAJA) — excluidos de
-- mrrUpgradeArs/mrrDowngradeArs aunque tengan precio resoluble.
ALTER TABLE "FinanceMonthlySnapshot" ADD COLUMN "enforcementPlanChangeEventsExcluded" INTEGER NOT NULL DEFAULT 0;
