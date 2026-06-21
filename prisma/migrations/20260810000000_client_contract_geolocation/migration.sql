-- client-geolocation: Prominense-owned GPS on Client (lat/lng/plusCode)
-- and on Contract (gpsLat/gpsLng/gpsPlusCode, separate from the GR-owned lat/lng).
-- All columns are nullable — safe zero-downtime migration.
ALTER TABLE "Client" ADD COLUMN "lat" DOUBLE PRECISION;
ALTER TABLE "Client" ADD COLUMN "lng" DOUBLE PRECISION;
ALTER TABLE "Client" ADD COLUMN "plusCode" TEXT;

ALTER TABLE "Contract" ADD COLUMN "gpsLat" DOUBLE PRECISION;
ALTER TABLE "Contract" ADD COLUMN "gpsLng" DOUBLE PRECISION;
ALTER TABLE "Contract" ADD COLUMN "gpsPlusCode" TEXT;
