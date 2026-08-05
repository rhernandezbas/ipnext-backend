-- CreateTable
CREATE TABLE "WifiGuestIntent" (
    "id" TEXT NOT NULL,
    "sn" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "port" TEXT NOT NULL,
    "since" TIMESTAMP(3) NOT NULL,
    "retriedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WifiGuestIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WifiGuestIntent_sn_key" ON "WifiGuestIntent"("sn");

