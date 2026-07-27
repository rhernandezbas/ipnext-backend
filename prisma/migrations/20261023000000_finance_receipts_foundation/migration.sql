-- finance-growth-dashboard Fase 1 — fundación de datos del ingest de cobranza
-- GR (action `recibos`). 100% ADITIVA: 4 tablas nuevas, cero columnas nuevas en
-- tablas existentes, `Invoice`/`Contract`/`ContractServiceEvent` intocados
-- (design.md Decision 0b). Generada con `prisma migrate diff --from-schema
-- <before> --to-schema prisma/schema.prisma --script` (sin DB), + los 2 INSERTs
-- de seed agregados a mano (molde 20261022000000_noc_alert_thresholds:
-- ON CONFLICT DO NOTHING).

-- CreateTable
CREATE TABLE "FinanceInvoiceTypeClassification" (
    "grType" TEXT NOT NULL,
    "bucket" VARCHAR(32) NOT NULL DEFAULT 'unclassified',
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceInvoiceTypeClassification_pkey" PRIMARY KEY ("grType")
);

-- CreateTable
CREATE TABLE "FinanceReceiptSyncConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "requestIntervalMs" INTEGER NOT NULL DEFAULT 20000,
    "maxRequestIntervalMs" INTEGER NOT NULL DEFAULT 300000,
    "deltaCheckIntervalMs" INTEGER NOT NULL DEFAULT 300000,
    "backfillFloorYearMonth" TEXT NOT NULL DEFAULT '2013-01',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceReceiptSyncConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancePaymentReceipt" (
    "grReceiptId" TEXT NOT NULL,
    "clientGrId" TEXT,
    "recaudador" TEXT,
    "fechaRecibo" TIMESTAMP(3),
    "fechaConfirmacion" TIMESTAMP(3),
    "anulado" BOOLEAN NOT NULL DEFAULT false,
    "observaciones" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancePaymentReceipt_pkey" PRIMARY KEY ("grReceiptId")
);

-- CreateTable
CREATE TABLE "FinanceReceiptApplication" (
    "grApplicationId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "grInvoiceId" TEXT NOT NULL,
    "grType" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "appliedDate" TIMESTAMP(3),

    CONSTRAINT "FinanceReceiptApplication_pkey" PRIMARY KEY ("grApplicationId")
);

-- CreateIndex
CREATE INDEX "FinancePaymentReceipt_clientGrId_idx" ON "FinancePaymentReceipt"("clientGrId");

-- CreateIndex
CREATE INDEX "FinancePaymentReceipt_fechaRecibo_idx" ON "FinancePaymentReceipt"("fechaRecibo");

-- CreateIndex
CREATE INDEX "FinanceReceiptApplication_grInvoiceId_idx" ON "FinanceReceiptApplication"("grInvoiceId");

-- CreateIndex
CREATE INDEX "FinanceReceiptApplication_appliedDate_idx" ON "FinanceReceiptApplication"("appliedDate");

-- CreateIndex
CREATE INDEX "FinanceReceiptApplication_receiptId_idx" ON "FinanceReceiptApplication"("receiptId");

-- AddForeignKey
ALTER TABLE "FinanceReceiptApplication" ADD CONSTRAINT "FinanceReceiptApplication_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "FinancePaymentReceipt"("grReceiptId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed idempotente: la ÚNICA certeza verificada en vivo (100 recibos de
-- muestra, `FB` = mayoría absoluta) — design.md Decision 2. `FA`/`FX`/`ID` NO
-- se siembran: se auto-clasifican `unclassified` en el primer sync real,
-- porque su semántica exacta no está confirmada.
INSERT INTO "FinanceInvoiceTypeClassification" ("grType", "bucket", "label", "createdAt", "updatedAt")
VALUES ('FB', 'revenue', 'Factura B', NOW(), NOW())
ON CONFLICT ("grType") DO NOTHING;

-- Seed idempotente de la fila singleton de pacing (design.md Decision 4b) —
-- garantiza que el scheduler/GET /sync/status siempre vean una fila real
-- desde el día 1, sin depender del fallback en código del repository.
--
-- ⚠️ `enabled = FALSE` A PROPÓSITO — DEPLOY DARK (decisión del usuario, 2026-07-26).
-- La Fase 1 llega a prod con el ingest APAGADO: cero llamadas a GR y cero
-- escrituras hasta que el usuario flipee el flag a mano. Se elige así porque el
-- primer arranque real dispara ~4.300 requests/día contra la API de un TERCERO
-- (Gestión Real) y escribe cientos de miles de filas, y eso es un efecto externo
-- que el usuario quiso decidir por separado del deploy del código.
-- Esto es una garantía DURA (no best-effort) recién a partir de fix-wave-3 R7 +
-- fix-wave-4 W3: antes, un fallo de la lectura de config al arrancar caía a
-- `enabled: true` optimista y reactivaba el ingest solo. Hoy `start()` lee la
-- config fail-CLOSED y `enabled` conserva el último valor observado, nunca vuelve
-- a `true` por su cuenta.
-- PARA ENCENDERLO: `UPDATE "FinanceReceiptSyncConfig" SET "enabled" = TRUE WHERE "id" = 'singleton';`
-- (el scheduler relee la config en CADA tick — fix-wave-2 F6 —, así que toma
-- efecto en <= requestIntervalMs, sin redeploy ni restart).
INSERT INTO "FinanceReceiptSyncConfig" ("id", "enabled", "requestIntervalMs", "maxRequestIntervalMs", "deltaCheckIntervalMs", "backfillFloorYearMonth", "updatedAt")
VALUES ('singleton', false, 20000, 300000, 300000, '2013-01', NOW())
ON CONFLICT ("id") DO NOTHING;
