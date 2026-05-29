-- CreateTable
CREATE TABLE "IClassResultCode" (
    "id" TEXT NOT NULL,
    "soTypeId" BIGINT,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "mappedStageId" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IClassResultCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IClassServiceOrder" (
    "id" TEXT NOT NULL,
    "iclassId" BIGINT NOT NULL,
    "iclassCodigo" TEXT NOT NULL,
    "clusterName" TEXT NOT NULL,
    "thirdPartyCode" TEXT,
    "nodeCode" TEXT,
    "soTypeDescription" TEXT,
    "customerCode" TEXT,
    "customerName" TEXT,
    "addressCode" TEXT,
    "addressLine" TEXT,
    "addressCity" TEXT,
    "addressLat" DOUBLE PRECISION,
    "addressLng" DOUBLE PRECISION,
    "statusCode" TEXT NOT NULL,
    "statusDescription" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3),
    "scheduledFor" TIMESTAMP(3),
    "availableAt" TIMESTAMP(3),
    "serviceStartedAt" TIMESTAMP(3),
    "serviceEndedAt" TIMESTAMP(3),
    "firstClosedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "resultCodeName" TEXT,
    "resultCodeType" TEXT,
    "closedByLogin" TEXT,
    "closedByName" TEXT,
    "closeLatitude" DOUBLE PRECISION,
    "closeLongitude" DOUBLE PRECISION,
    "closeGpsAt" TIMESTAMP(3),
    "billingAmount" DECIMAL(12,2),
    "technicianNote" TEXT,
    "internalNote" TEXT,
    "commentaryLog" TEXT,
    "teamLogin" TEXT,
    "teamTechnicianName" TEXT,
    "teamPhone" TEXT,
    "teamEmail" TEXT,
    "scheduledTaskId" TEXT,
    "iclassCreatedAt" TIMESTAMP(3),
    "iclassUpdatedAt" TIMESTAMP(3),
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawDetail" JSONB NOT NULL,

    CONSTRAINT "IClassServiceOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IClassSoStatusHistory" (
    "id" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "iclassOsStatusId" BIGINT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "statusCode" TEXT NOT NULL,
    "statusDescription" TEXT NOT NULL,
    "durationMinutes" INTEGER,
    "teamLogin" TEXT,
    "commentary" TEXT,

    CONSTRAINT "IClassSoStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IClassSoChecklist" (
    "id" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "iclassSurveyId" BIGINT NOT NULL,
    "surveyAt" TIMESTAMP(3),

    CONSTRAINT "IClassSoChecklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IClassSoChecklistAnswer" (
    "id" TEXT NOT NULL,
    "checklistId" TEXT NOT NULL,
    "questionId" BIGINT,
    "questionText" TEXT NOT NULL,
    "questionType" TEXT NOT NULL,
    "answerOrder" INTEGER NOT NULL,
    "answerText" TEXT,
    "photoMissing" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "IClassSoChecklistAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IClassSoMaterial" (
    "id" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "iclassOsMaterialId" BIGINT NOT NULL,
    "materialCode" TEXT,
    "materialDescription" TEXT,
    "qty" DECIMAL(12,4) NOT NULL,
    "unitValue" DECIMAL(12,2),
    "totalValue" DECIMAL(12,2),

    CONSTRAINT "IClassSoMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IClassSoEquipmentEvent" (
    "id" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "type" TEXT,
    "serialNumber" TEXT,
    "mac" TEXT,
    "patrimonialNo" TEXT,
    "modelDescription" TEXT,

    CONSTRAINT "IClassSoEquipmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IClassResultCode_code_idx" ON "IClassResultCode"("code");

-- CreateIndex
CREATE INDEX "IClassResultCode_mappedStageId_idx" ON "IClassResultCode"("mappedStageId");

-- CreateIndex
CREATE UNIQUE INDEX "IClassResultCode_soTypeId_code_key" ON "IClassResultCode"("soTypeId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "IClassServiceOrder_iclassId_key" ON "IClassServiceOrder"("iclassId");

-- CreateIndex
CREATE UNIQUE INDEX "IClassServiceOrder_iclassCodigo_key" ON "IClassServiceOrder"("iclassCodigo");

-- CreateIndex
CREATE UNIQUE INDEX "IClassServiceOrder_scheduledTaskId_key" ON "IClassServiceOrder"("scheduledTaskId");

-- CreateIndex
CREATE INDEX "IClassServiceOrder_clusterName_closedAt_idx" ON "IClassServiceOrder"("clusterName", "closedAt");

-- CreateIndex
CREATE INDEX "IClassServiceOrder_customerCode_idx" ON "IClassServiceOrder"("customerCode");

-- CreateIndex
CREATE INDEX "IClassServiceOrder_iclassUpdatedAt_idx" ON "IClassServiceOrder"("iclassUpdatedAt");

-- CreateIndex
CREATE INDEX "IClassServiceOrder_scheduledTaskId_idx" ON "IClassServiceOrder"("scheduledTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "IClassSoStatusHistory_iclassOsStatusId_key" ON "IClassSoStatusHistory"("iclassOsStatusId");

-- CreateIndex
CREATE INDEX "IClassSoStatusHistory_serviceOrderId_occurredAt_idx" ON "IClassSoStatusHistory"("serviceOrderId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "IClassSoChecklist_iclassSurveyId_key" ON "IClassSoChecklist"("iclassSurveyId");

-- CreateIndex
CREATE INDEX "IClassSoChecklistAnswer_checklistId_answerOrder_idx" ON "IClassSoChecklistAnswer"("checklistId", "answerOrder");

-- CreateIndex
CREATE UNIQUE INDEX "IClassSoMaterial_iclassOsMaterialId_key" ON "IClassSoMaterial"("iclassOsMaterialId");

-- CreateIndex
CREATE INDEX "IClassSoEquipmentEvent_serviceOrderId_idx" ON "IClassSoEquipmentEvent"("serviceOrderId");

-- AddForeignKey
ALTER TABLE "IClassResultCode" ADD CONSTRAINT "IClassResultCode_mappedStageId_fkey" FOREIGN KEY ("mappedStageId") REFERENCES "Stage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IClassServiceOrder" ADD CONSTRAINT "IClassServiceOrder_scheduledTaskId_fkey" FOREIGN KEY ("scheduledTaskId") REFERENCES "ScheduledTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IClassSoStatusHistory" ADD CONSTRAINT "IClassSoStatusHistory_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "IClassServiceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IClassSoChecklist" ADD CONSTRAINT "IClassSoChecklist_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "IClassServiceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IClassSoChecklistAnswer" ADD CONSTRAINT "IClassSoChecklistAnswer_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "IClassSoChecklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IClassSoMaterial" ADD CONSTRAINT "IClassSoMaterial_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "IClassServiceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IClassSoEquipmentEvent" ADD CONSTRAINT "IClassSoEquipmentEvent_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES "IClassServiceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- SEED: feature flag for the closure loop (idempotent, default OFF — flip on after rollout)
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('iclass-closure-loop', false, NOW())
ON CONFLICT ("key") DO NOTHING;
