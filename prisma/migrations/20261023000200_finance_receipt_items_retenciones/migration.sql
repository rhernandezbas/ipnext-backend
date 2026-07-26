-- fix-wave-2 R1 — persistir `items[]` (cash) y `retenciones[]` (certificados
-- impositivos) del recibo GR, hasta ahora descartados por el parser. 100%
-- ADITIVA: 2 tablas nuevas, cero columnas nuevas en tablas existentes.
-- `aplicaciones` (FinanceReceiptApplication, ya existente) sigue siendo deuda
-- CANCELADA; `items` (nuevo) es la base de la métrica "cash collected" del
-- spec; `retenciones` (nuevo) NUNCA es cash, se expone como serie aparte.
-- Medido en vivo (junio 2026, 4.839 recibos): SUM(aplicaciones) - SUM(items) -
-- SUM(retenciones) = -0.00, identidad exacta. Decisión LOCK del usuario
-- 2026-07-26: persistir las TRES cifras por separado hace la decisión
-- reversible sin re-ingerir los 163 meses de historia.

-- CreateTable
CREATE TABLE "FinanceReceiptItem" (
    "grItemId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "banco" TEXT,
    "cajaCuentaId" TEXT,
    "destino" TEXT,
    "fecha" TIMESTAMP(3),
    "amount" DECIMAL(12,2) NOT NULL,
    "moneda" TEXT,
    "numeroTransferencia" TEXT,
    "tipo" TEXT,

    CONSTRAINT "FinanceReceiptItem_pkey" PRIMARY KEY ("grItemId")
);

-- CreateTable
CREATE TABLE "FinanceReceiptRetencion" (
    "grRetencionId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "tipo" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "fecha" TIMESTAMP(3),

    CONSTRAINT "FinanceReceiptRetencion_pkey" PRIMARY KEY ("grRetencionId")
);

-- CreateIndex
CREATE INDEX "FinanceReceiptItem_receiptId_idx" ON "FinanceReceiptItem"("receiptId");

-- CreateIndex
CREATE INDEX "FinanceReceiptRetencion_receiptId_idx" ON "FinanceReceiptRetencion"("receiptId");

-- AddForeignKey
ALTER TABLE "FinanceReceiptItem" ADD CONSTRAINT "FinanceReceiptItem_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "FinancePaymentReceipt"("grReceiptId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReceiptRetencion" ADD CONSTRAINT "FinanceReceiptRetencion_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "FinancePaymentReceipt"("grReceiptId") ON DELETE RESTRICT ON UPDATE CASCADE;
