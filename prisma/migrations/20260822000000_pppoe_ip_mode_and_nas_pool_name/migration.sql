-- pppoe-pool-ip Fase 1: ipMode por servicio + poolName por NAS (aditiva, sin backfill).
-- Los ~2287 servicios fijos quedan ipMode='fixed' por el default → IP intacta.
-- NasServer.poolName nulo = comportamiento legacy (ningún NAS arranca en modo pool).
ALTER TABLE "PppoeService" ADD COLUMN "ipMode" TEXT NOT NULL DEFAULT 'fixed';
ALTER TABLE "NasServer" ADD COLUMN "poolName" TEXT;
