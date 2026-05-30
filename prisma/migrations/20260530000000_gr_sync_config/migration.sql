-- CreateTable
CREATE TABLE "GestionRealSyncConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "intervalMs" INTEGER NOT NULL DEFAULT 180000,
    "estados" TEXT NOT NULL DEFAULT '1,2,3,4,6',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GestionRealSyncConfig_pkey" PRIMARY KEY ("id")
);
