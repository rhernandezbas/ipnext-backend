-- wifi-password-snapshot — snapshot de la password de cada banda WiFi de una
-- ONU. SmartOLT nunca la devuelve en get_onu_details (verificado en vivo,
-- ver docblock del modelo OnuWifiCredential en schema.prisma) — Prominense
-- la recuerda acá, upsert por (sn, port), cada vez que alguien la escribe.
--
-- Additive only: 1 CREATE TABLE + unique compuesto (sn, port). Sin DROP, sin
-- backfill — no hay datos previos que migrar (la password nunca vivió en
-- ningún lado antes de esto).

-- CreateTable
CREATE TABLE "OnuWifiCredential" (
    "id"        TEXT NOT NULL,
    "sn"        TEXT NOT NULL,
    "port"      TEXT NOT NULL,
    "ssid"      TEXT NOT NULL,
    "password"  TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "OnuWifiCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnuWifiCredential_sn_port_key" ON "OnuWifiCredential"("sn", "port");
