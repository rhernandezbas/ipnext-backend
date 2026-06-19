-- Migration: 20260801002000_rbac_user_gr_vendedor_name
-- Mis clientes (Fase 2): adds grVendedorName (nombre del vendedor en Gestión Real) to RbacUser.
-- Soft mapping, nullable, sin FK física. Mismo patrón que iclassTeamLogin.
-- Aditiva, idempotente, sin BEGIN/COMMIT (Prisma envuelve cada migración).

ALTER TABLE "RbacUser" ADD COLUMN IF NOT EXISTS "grVendedorName" TEXT;
