-- CreateTable: IClassDispatchAttempt (audit minimo de intentos de envio a IClass)
CREATE TABLE "IClassDispatchAttempt" (
    "id"                TEXT NOT NULL,
    "taskId"            TEXT NOT NULL,
    "outcome"           TEXT NOT NULL,
    "errorCode"         TEXT,
    "errorMessage"      TEXT,
    "attemptedNodeCode" TEXT,
    "resolvedNodeCode"  TEXT,
    "actorId"           TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IClassDispatchAttempt_pkey" PRIMARY KEY ("id")
);

-- Index para listByTask ordenado por fecha
CREATE INDEX "IClassDispatchAttempt_taskId_createdAt_idx"
    ON "IClassDispatchAttempt"("taskId", "createdAt");

-- FK a ScheduledTask con borrado en cascada (si se borra la task, se borran sus intentos)
ALTER TABLE "IClassDispatchAttempt"
    ADD CONSTRAINT "IClassDispatchAttempt_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
