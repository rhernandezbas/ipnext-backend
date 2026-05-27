-- AlterTable: add location fields to Service (all nullable, no backfill)
ALTER TABLE "Service" ADD COLUMN "address" TEXT;
ALTER TABLE "Service" ADD COLUMN "lat"     DOUBLE PRECISION;
ALTER TABLE "Service" ADD COLUMN "lng"     DOUBLE PRECISION;
