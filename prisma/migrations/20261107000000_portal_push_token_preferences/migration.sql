-- push-per-device — las preferencias de push (`serviceAlerts`/`promos`) se
-- mudan de la CUENTA (`PortalPushPreference`, 1 fila por cuenta) al TOKEN
-- (`PortalPushToken`, 1 fila por dispositivo). Motivo: una cuenta del portal
-- = un contrato = una CASA — marido, mujer, hijos, varios teléfonos con la
-- MISMA cuenta. Con la preferencia por cuenta, uno apaga las promos y se las
-- apaga a TODOS; peor, uno acepta marketing y el otro —que nunca consintió—
-- empieza a recibirlo. El APARATO se parece más a la persona que la cuenta.
--
-- Additive only: 4 ADD COLUMN con DEFAULT (mismo valor SEGURO que el schema
-- ya documentaba a nivel de cuenta: serviceAlerts=true, promos=false) + 1
-- backfill que copia, POR CUENTA, la preferencia vieja hacia TODOS los
-- tokens de esa cuenta — nadie pierde su configuración. No DROP: la tabla
-- `PortalPushPreference` queda huérfana a propósito (ver el docblock del
-- modelo en schema.prisma) — borrarla es una migración destructiva aparte.
-- No BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia
-- transacción).

-- AlterTable
ALTER TABLE "PortalPushToken" ADD COLUMN "serviceAlerts" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "PortalPushToken" ADD COLUMN "promos" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PortalPushToken" ADD COLUMN "promosOptInAt" TIMESTAMP(3);
ALTER TABLE "PortalPushToken" ADD COLUMN "promosOptInAppVersion" TEXT;

-- Backfill: copia la preferencia de CADA cuenta hacia TODOS sus tokens (join
-- por accountId — funciona para N cuentas/N tokens, no solo el caso 1:1 de
-- hoy). Las cuentas que nunca tuvieron `PortalPushPreference` (nunca abrieron
-- la pantalla de notificaciones) quedan con los DEFAULT recién agregados
-- arriba, que son los mismos valores que `PortalPushPreferenceRepository.getOrCreate`
-- les habría dado.
UPDATE "PortalPushToken" t
SET "serviceAlerts" = p."serviceAlerts",
    "promos" = p."promos",
    "promosOptInAt" = p."promosOptInAt",
    "promosOptInAppVersion" = p."promosOptInAppVersion"
FROM "PortalPushPreference" p
WHERE p."accountId" = t."accountId";
