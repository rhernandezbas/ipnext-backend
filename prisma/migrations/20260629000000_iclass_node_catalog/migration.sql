-- nodes-city-mapper (#45) — IClass node catalog (aditiva)
-- Prisma wraps each migration in its own transaction; no BEGIN/COMMIT here.

CREATE TABLE "IClassNode" (
    "id" TEXT NOT NULL,
    "nodeId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "selectable" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IClassNode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IClassNode_nodeId_key" ON "IClassNode"("nodeId");
CREATE INDEX "IClassNode_active_idx" ON "IClassNode"("active");
