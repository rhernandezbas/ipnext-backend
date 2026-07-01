-- CreateTable
CREATE TABLE "PppoeNasMoveEvent" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "pppoeServiceId" TEXT,
    "fromNasId" TEXT,
    "toNasId" TEXT,
    "fromIp" TEXT,
    "toIp" TEXT,
    "trigger" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PppoeNasMoveEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PppoeNasMoveEvent_createdAt_idx" ON "PppoeNasMoveEvent"("createdAt");

-- CreateIndex
CREATE INDEX "PppoeNasMoveEvent_username_idx" ON "PppoeNasMoveEvent"("username");

-- CreateIndex
CREATE INDEX "PppoeNasMoveEvent_outcome_createdAt_idx" ON "PppoeNasMoveEvent"("outcome", "createdAt");

-- CreateIndex
CREATE INDEX "PppoeNasMoveEvent_trigger_createdAt_idx" ON "PppoeNasMoveEvent"("trigger", "createdAt");

