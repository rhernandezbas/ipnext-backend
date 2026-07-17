-- K3 (fiber-auto-watcher): full-auto de fibra — serial en la tarea + watcher de aprovisionamiento.

-- 1) Serial de la ONU en la tarea de instalación (aditiva, NULL = sin serial).
--    Normalizado UPPERCASE sin espacios al persistir (UpdateTask). El watcher matchea
--    este serial contra las ONUs sin configurar de SmartOLT.
ALTER TABLE "ScheduledTask" ADD COLUMN IF NOT EXISTS "onuSerial" TEXT;
CREATE INDEX IF NOT EXISTS "ScheduledTask_onuSerial_idx" ON "ScheduledTask"("onuSerial");

-- 2) Registro de intentos del watcher — anti-reintento infinito, PERSISTIDO (sobrevive
--    restarts). Una fila por (taskId, onuSn); estados terminales no se reintentan.
CREATE TABLE IF NOT EXISTS "FiberAutoProvisionAttempt" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "onuSn" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiberAutoProvisionAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FiberAutoProvisionAttempt_taskId_onuSn_key" ON "FiberAutoProvisionAttempt"("taskId", "onuSn");

-- FK con guard idempotente (ALTER TABLE ... ADD CONSTRAINT no soporta IF NOT EXISTS en PG).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FiberAutoProvisionAttempt_taskId_fkey'
  ) THEN
    ALTER TABLE "FiberAutoProvisionAttempt"
      ADD CONSTRAINT "FiberAutoProvisionAttempt_taskId_fkey"
      FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 3) Feature flag 'fiber-auto-provision-watcher' (seed OFF — rollout oscuro). SEPARADO del
--    flag del wizard 'fiber-auto-provision': el botón manual y el watcher se prenden/apagan
--    de forma independiente. Sin este seed el PATCH de flags no puede prenderlo (usa update,
--    no upsert — lección install-pppoe-pregen). Idempotente.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('fiber-auto-provision-watcher', false, NOW())
ON CONFLICT DO NOTHING;
