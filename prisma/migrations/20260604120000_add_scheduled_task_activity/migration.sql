-- CreateTable
CREATE TABLE "ScheduledTaskActivity" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "fromValue" JSONB,
    "toValue" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledTaskActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledTaskActivity_taskId_createdAt_id_idx" ON "ScheduledTaskActivity"("taskId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ScheduledTaskActivity_actorId_idx" ON "ScheduledTaskActivity"("actorId");

-- AddForeignKey
ALTER TABLE "ScheduledTaskActivity" ADD CONSTRAINT "ScheduledTaskActivity_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledTaskActivity" ADD CONSTRAINT "ScheduledTaskActivity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
