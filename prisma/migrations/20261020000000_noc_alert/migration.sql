-- noc-alerts-hub Fase A — tabla NocAlert (hub unificado de alertas NOC) + seed de
-- flags de convivencia. Aditiva: NO toca MonitoringAlert ni Notification (ver
-- comentario de coexistencia en schema.prisma). Ambos INSERT de FeatureFlag son
-- idempotentes (ON CONFLICT DO NOTHING sobre el PK "key"), mismo patrón que
-- 20260905000100_chat_media_download_flag.

-- CreateTable
CREATE TABLE "NocAlert" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "alertname" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'firing',
    "entityType" TEXT NOT NULL,
    "entityName" TEXT NOT NULL,
    "entityRef" TEXT,
    "metricName" TEXT,
    "metricValue" DOUBLE PRECISION,
    "metricUnit" TEXT,
    "threshold" DOUBLE PRECISION,
    "message" TEXT NOT NULL,
    "explanation" TEXT,
    "link" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "ackBy" TEXT,
    "ackAt" TIMESTAMP(3),
    "ackNote" TEXT,
    "escalationState" TEXT,
    "telegramChatId" TEXT,
    "telegramMessageId" TEXT,

    CONSTRAINT "NocAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NocAlert_status_idx" ON "NocAlert"("status");

-- CreateIndex
CREATE INDEX "NocAlert_severity_idx" ON "NocAlert"("severity");

-- CreateIndex
CREATE UNIQUE INDEX "NocAlert_source_fingerprint_key" ON "NocAlert"("source", "fingerprint");

-- Feature flags de convivencia (dark launch — design.md "Decision: Flags de
-- convivencia = filas FeatureFlag DB-backed"):
--   noc-alerts-hub-enabled     ON  — ingesta+persistencia+panel+SSE del hub arrancan.
--   noc-alerts-telegram-send   OFF — el hub NO manda a Telegram; noc_metrics.py y
--                                    Grafana→Telegram siguen siendo los únicos que
--                                    notifican hasta el cutover (OK explícito del usuario).
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('noc-alerts-hub-enabled', true, NOW())
ON CONFLICT DO NOTHING;

INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('noc-alerts-telegram-send', false, NOW())
ON CONFLICT DO NOTHING;
