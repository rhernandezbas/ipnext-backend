-- noc-alerts-config F1 — tabla NocAlertThresholdsConfig (umbrales editables de
-- fibra, singleton) + seed idempotente de la fila con los defaults vigentes en
-- /etc/fibra_report.conf (VM 130). 100% ADITIVA — no toca ninguna tabla
-- existente. Generada con `prisma migrate diff --from-schema <before>
-- --to-schema prisma/schema.prisma --script` (sin DB), + el INSERT de seed
-- agregado a mano (molde 20261020000000_noc_alert: ON CONFLICT DO NOTHING).
--
-- Field NAMES son el contrato de wire compartido con el colector Rust
-- (ipnext-noc-collector/src/config.rs::Thresholds, serde camelCase) —
-- critDbm/warnDbm/deltaAlert/ponMinAbon/ponDelta EXACTOS, no renombrar.

-- CreateTable
CREATE TABLE "NocAlertThresholdsConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "critDbm" DOUBLE PRECISION NOT NULL DEFAULT -30,
    "warnDbm" DOUBLE PRECISION NOT NULL DEFAULT -27,
    "deltaAlert" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "ponMinAbon" INTEGER NOT NULL DEFAULT 2,
    "ponDelta" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NocAlertThresholdsConfig_pkey" PRIMARY KEY ("id")
);

-- Seed idempotente de la fila singleton con los defaults (espejo de
-- /etc/fibra_report.conf) — garantiza que GET /api/alerts/thresholds
-- (panel Y colector Rust) siempre vea una fila real desde el día 1, sin
-- depender del fallback en código del repository.
INSERT INTO "NocAlertThresholdsConfig" ("id", "critDbm", "warnDbm", "deltaAlert", "ponMinAbon", "ponDelta", "updatedAt")
VALUES ('singleton', -30, -27, 2.0, 2, 1.5, NOW())
ON CONFLICT DO NOTHING;
