-- Migration: 20260520050000_scheduling_checklists
-- DDL only — no data to backfill

CREATE TABLE "TaskTemplateItem" (
  "id"         TEXT         NOT NULL,
  "templateId" TEXT         NOT NULL,
  "text"       TEXT         NOT NULL,
  "order"      INTEGER      NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TaskTemplateItem_pkey"          PRIMARY KEY ("id"),
  CONSTRAINT "TaskTemplateItem_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "TaskTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "TaskTemplateItem_templateId_order_idx"
  ON "TaskTemplateItem"("templateId", "order");

CREATE TABLE "TaskChecklistItem" (
  "id"                 TEXT         NOT NULL,
  "taskId"             TEXT         NOT NULL,
  "text"               TEXT         NOT NULL,
  "done"               BOOLEAN      NOT NULL DEFAULT FALSE,
  "order"              INTEGER      NOT NULL,
  "fromTemplateItemId" TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TaskChecklistItem_pkey"   PRIMARY KEY ("id"),
  CONSTRAINT "TaskChecklistItem_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskChecklistItem_fromTemplateItemId_fkey"
    FOREIGN KEY ("fromTemplateItemId") REFERENCES "TaskTemplateItem"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "TaskChecklistItem_taskId_order_idx"
  ON "TaskChecklistItem"("taskId", "order");
