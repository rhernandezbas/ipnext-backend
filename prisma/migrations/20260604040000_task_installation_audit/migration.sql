-- CreateTable
CREATE TABLE "TaskInstallationAudit" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "auditedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskInstallationAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskAuditFinding" (
    "id" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "photoUrls" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskAuditFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskInstallationAudit_taskId_key" ON "TaskInstallationAudit"("taskId");

-- CreateIndex
CREATE INDEX "TaskInstallationAudit_taskId_idx" ON "TaskInstallationAudit"("taskId");

-- CreateIndex
CREATE INDEX "TaskAuditFinding_auditId_idx" ON "TaskAuditFinding"("auditId");

-- AddForeignKey
ALTER TABLE "TaskInstallationAudit" ADD CONSTRAINT "TaskInstallationAudit_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAuditFinding" ADD CONSTRAINT "TaskAuditFinding_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "TaskInstallationAudit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
