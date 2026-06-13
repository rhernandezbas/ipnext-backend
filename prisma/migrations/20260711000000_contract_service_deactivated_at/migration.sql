-- Additive only. No BEGIN/COMMIT (Prisma wraps each migration in its own transaction).
ALTER TABLE "ContractService" ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMP(3);
