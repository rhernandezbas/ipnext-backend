-- CreateTable
CREATE TABLE "RadiusAuthEvent" (
    "id" TEXT NOT NULL,
    "sourceUniqueId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "reply" TEXT NOT NULL,
    "authdate" TIMESTAMP(3) NOT NULL,
    "class" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RadiusAuthEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RadiusAuthEvent_sourceUniqueId_key" ON "RadiusAuthEvent"("sourceUniqueId");

-- CreateIndex
CREATE INDEX "RadiusAuthEvent_username_idx" ON "RadiusAuthEvent"("username");

-- CreateIndex
CREATE INDEX "RadiusAuthEvent_reply_idx" ON "RadiusAuthEvent"("reply");

-- CreateIndex
CREATE INDEX "RadiusAuthEvent_authdate_idx" ON "RadiusAuthEvent"("authdate");

-- CreateIndex
CREATE INDEX "RadiusAuthEvent_reply_authdate_idx" ON "RadiusAuthEvent"("reply", "authdate");
