-- CreateTable
CREATE TABLE "RadiusSessionCureEvent" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "nasIp" TEXT,
    "sessionId" TEXT,
    "sessionStartedAt" TIMESTAMP(3),
    "sessionLastUpdate" TIMESTAMP(3),
    "signalUsed" TEXT,
    "trigger" TEXT NOT NULL,
    "action" TEXT,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RadiusSessionCureEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RadiusSessionCureEvent_createdAt_idx" ON "RadiusSessionCureEvent"("createdAt");

-- CreateIndex
CREATE INDEX "RadiusSessionCureEvent_username_idx" ON "RadiusSessionCureEvent"("username");

-- CreateIndex
CREATE INDEX "RadiusSessionCureEvent_outcome_createdAt_idx" ON "RadiusSessionCureEvent"("outcome", "createdAt");

-- CreateIndex
CREATE INDEX "RadiusSessionCureEvent_trigger_createdAt_idx" ON "RadiusSessionCureEvent"("trigger", "createdAt");
