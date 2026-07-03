-- DropIndex
DROP INDEX "Invoice_number_key";

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "balance" DECIMAL(12,2),
ADD COLUMN     "couponPdfUrl" TEXT,
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "grInvoiceId" TEXT,
ADD COLUMN     "grType" TEXT,
ADD COLUMN     "paymentUrl" TEXT,
ADD COLUMN     "pdfUrl" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_grInvoiceId_key" ON "Invoice"("grInvoiceId");
