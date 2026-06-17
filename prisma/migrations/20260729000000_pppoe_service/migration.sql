-- CreateTable
CREATE TABLE "PppoeService" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "profile" TEXT,
    "remoteAddress" TEXT,
    "status" TEXT NOT NULL DEFAULT 'enabled',
    "nasId" TEXT NOT NULL,
    "contractId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PppoeService_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "PppoeService_username_key" ON "PppoeService"("username");
-- CreateIndex
CREATE INDEX "PppoeService_nasId_idx" ON "PppoeService"("nasId");
-- CreateIndex
CREATE INDEX "PppoeService_contractId_idx" ON "PppoeService"("contractId");
-- AddForeignKey
ALTER TABLE "PppoeService" ADD CONSTRAINT "PppoeService_nasId_fkey" FOREIGN KEY ("nasId") REFERENCES "NasServer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "PppoeService" ADD CONSTRAINT "PppoeService_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
