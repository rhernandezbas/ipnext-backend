-- finance-growth-dashboard Fase 2 — settables de configuración editable:
-- costo por tecnología, precio estimado por plan, metas globales (singleton)
-- e índice IPC mensual (design.md Data Model). 100% ADITIVA: 4 tablas
-- nuevas, cero columnas nuevas en tablas existentes, ninguna FK dura hacia
-- `ContractTechnology`/`Plan` (claves naturales, deuda declarada #2 del
-- design). Generada con `npx prisma migrate diff --from-schema <before> --to-schema
-- prisma/schema.prisma --script` (sin DB), + el INSERT de seed agregado a
-- mano (molde 20261023000000_finance_receipts_foundation: ON CONFLICT DO
-- NOTHING respaldado por la PK real de la tabla). Sin BEGIN/COMMIT (Prisma
-- envuelve cada migración en su propia transacción).

-- CreateTable
CREATE TABLE "FinanceTechnologyCost" (
    "technologyName" TEXT NOT NULL,
    "costoVentaArs" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "costoInstalacionArs" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "costoMensualServicioArs" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "comisionVentaPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceTechnologyCost_pkey" PRIMARY KEY ("technologyName")
);

-- CreateTable
CREATE TABLE "FinancePlanPrice" (
    "planCode" TEXT NOT NULL,
    "estimatedMonthlyPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancePlanPrice_pkey" PRIMARY KEY ("planCode")
);

-- CreateTable
CREATE TABLE "FinanceTargetsConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "churnTargetPct" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "maxPaybackMonths" INTEGER NOT NULL DEFAULT 12,
    "monthlyNewContractsGoal" INTEGER NOT NULL DEFAULT 0,
    "inflationBaseYearMonth" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceTargetsConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceInflationIndex" (
    "yearMonth" TEXT NOT NULL,
    "monthlyRatePct" DECIMAL(6,3) NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceInflationIndex_pkey" PRIMARY KEY ("yearMonth")
);

-- Seed: the singleton targets row, so GetFinanceTargets/PrismaFinanceTargetsConfigRepository
-- can rely on it existing (the repo also falls back to FINANCE_TARGETS_CONFIG_DEFAULTS in
-- code for defense-in-depth, but the row is the source of truth once this migration runs).
-- ON CONFLICT backed by the REAL primary key ("id").
INSERT INTO "FinanceTargetsConfig" ("id", "churnTargetPct", "maxPaybackMonths", "monthlyNewContractsGoal", "inflationBaseYearMonth", "updatedAt")
VALUES ('singleton', 5, 12, 0, '', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
