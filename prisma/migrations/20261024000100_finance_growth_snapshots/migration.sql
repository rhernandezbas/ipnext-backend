-- finance-growth-dashboard Fase 3 — motor de métricas: snapshots nocturnos
-- precomputados (design.md Data Model, Decision 4). 100% ADITIVA: 2 tablas
-- nuevas, cero columnas nuevas en tablas existentes, cero FKs (ambas se leen
-- exclusivamente por PK compuesta/simple desde BuildFinanceMonthlySnapshot/
-- BuildFinanceCohortSnapshot). Sin BEGIN/COMMIT (Prisma envuelve cada
-- migración en su propia transacción). Sin seed: ambas tablas se completan
-- SOLO por el job nocturno, nunca tienen datos "de fábrica".

-- CreateTable
CREATE TABLE "FinanceMonthlySnapshot" (
    "yearMonth" TEXT NOT NULL,
    "contractsActive" INTEGER NOT NULL,
    "contractsNew" INTEGER NOT NULL,
    "contractsChurned" INTEGER NOT NULL,
    "contractsUpgraded" INTEGER NOT NULL,
    "contractsDowngraded" INTEGER NOT NULL,
    "mrrInicialArs" DECIMAL(14,2) NOT NULL,
    "mrrNewArs" DECIMAL(14,2) NOT NULL,
    "mrrUpgradeArs" DECIMAL(14,2) NOT NULL,
    "mrrDowngradeArs" DECIMAL(14,2) NOT NULL,
    "mrrChurnArs" DECIMAL(14,2) NOT NULL,
    "mrrFinalArs" DECIMAL(14,2) NOT NULL,
    "revenueTotalArs" DECIMAL(14,2) NOT NULL,
    "revenueAttributableArs" DECIMAL(14,2) NOT NULL,
    "unclassifiedAmountArs" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "attributionPct" DECIMAL(5,2) NOT NULL,
    "arpuArs" DECIMAL(12,2) NOT NULL,
    "churnContractsPct" DECIMAL(5,2) NOT NULL,
    "churnRevenuePct" DECIMAL(5,2) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceMonthlySnapshot_pkey" PRIMARY KEY ("yearMonth")
);

-- CreateTable
CREATE TABLE "FinanceCohortSnapshot" (
    "cohortYearMonth" TEXT NOT NULL,
    "monthsElapsed" INTEGER NOT NULL,
    "originalCount" INTEGER NOT NULL,
    "survivingCount" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceCohortSnapshot_pkey" PRIMARY KEY ("cohortYearMonth","monthsElapsed")
);
