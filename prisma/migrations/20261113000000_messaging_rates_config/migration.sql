-- twilio-credit-guard (D1) — 1 tabla nueva + 1 columna, todo aditivo.
--
-- MessagingRatesConfig: tarifas configurables por categoría de template +
-- fee del proveedor, editables sin redeploy. Fila única `id='singleton'`,
-- molde EXACTO ExternalBulkMessagingConfig — la fila nace PEREZOSAMENTE en
-- el primer get()/set() (fix F14 clonado), no hay backfill acá.
--
-- ExternalBulkPreview.credit: snapshot ADVISORY JSONB nullable de lo que se
-- le mostró a quien autorizó (D1.b). FUERA del payloadHash (D1.c) — el
-- balance es dato del proveedor, no input del caller. Previews vivos
-- anteriores a este change siguen válidos sin backfill.
--
-- Generado sin DB con:
--   npx prisma migrate diff --from-schema <schema en HEAD> \
--                            --to-schema prisma/schema.prisma --script
-- Sin BEGIN/COMMIT — Prisma envuelve cada migración en su propia transacción.
--
-- El prefijo NO es una fecha real: es la secuencia monotónica sintética del
-- repo, posterior a la última migración existente (20261112000000).

-- AlterTable
ALTER TABLE "ExternalBulkPreview" ADD COLUMN     "credit" JSONB;

-- CreateTable
CREATE TABLE "MessagingRatesConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "utilityRate" DECIMAL(10,4) NOT NULL DEFAULT 0.0120,
    "marketingRate" DECIMAL(10,4) NOT NULL DEFAULT 0.0618,
    "authenticationRate" DECIMAL(10,4) NOT NULL DEFAULT 0.0220,
    "providerFee" DECIMAL(10,4) NOT NULL DEFAULT 0.0050,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessagingRatesConfig_pkey" PRIMARY KEY ("id")
);

-- fix wave F1 (F7) — Feature flag PROPIO del guard de credito, sembrado en TRUE.
--
-- Por que hace falta una perilla separada: sin ella, el unico boton ante un
-- falso positivo del guard (tarifas mal cargadas, Twilio devolviendo basura,
-- un mismatch de moneda) era apagar `messaging-external-bulk-enabled`, o sea
-- matar la API externa ENTERA para arreglar el medidor. Con esta fila en
-- `false` el guard se saltea (fail-OPEN por decision EXPLICITA del operador)
-- y el envio sigue funcionando.
--
-- Nace en TRUE (al reves que el kill-switch, que deploya DARK): el guard es
-- una PROTECCION, y este change se despliega con ella puesta. La ausencia de
-- la fila y un repo caido tambien resuelven a ON en el codigo (fail-closed).
--
-- Se opera con el `PATCH /api/admin/feature-flags/:key` generico que YA
-- existe (gate admin.flags) — cero trabajo de FE.
--
-- DEBE nacer de la migracion: SetFeatureFlag hace `update`, NO `upsert`.
-- Idempotente: ON CONFLICT DO NOTHING sobre el PK `key`.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('messaging-credit-guard-enabled', true, NOW())
ON CONFLICT DO NOTHING;
