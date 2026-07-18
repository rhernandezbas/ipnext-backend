-- Migration: 20261001000000_noc_broadcast_config
-- N1 (noc-broadcast) — fundación de la difusión NOC vía Evolution API.
-- 100% ADITIVA: nueva tabla single-row NocBroadcastConfig (molde GestionRealIngestConfig,
-- id constante "singleton"). Todos los campos con default (feature opt-in OFF/empty por
-- defecto) para no requerir backfill. Sin FKs, sin índices extra. Reusa los permisos
-- messaging.read / messaging.manage YA sembrados — no siembra nada.
-- No explicit transaction block (Prisma wraps each migration in its own transaction).

-- CreateTable
CREATE TABLE "NocBroadcastConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "evolutionBaseUrl" TEXT NOT NULL DEFAULT '',
    "evolutionApiKey" TEXT NOT NULL DEFAULT '',
    "evolutionInstance" TEXT NOT NULL DEFAULT '',
    "targetChat" TEXT NOT NULL DEFAULT '',
    "appPublicUrl" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NocBroadcastConfig_pkey" PRIMARY KEY ("id")
);
