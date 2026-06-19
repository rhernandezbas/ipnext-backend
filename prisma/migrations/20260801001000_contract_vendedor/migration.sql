-- Add the GR `vendedor` (agente que dio de alta) to Contract.
-- Additive + nullable: existing rows get NULL; the GR sync populates it from here on
-- (GR exposes `vendedor` per contract). Base for the "Mis clientes" (cartera por agente) feature.
ALTER TABLE "Contract" ADD COLUMN "vendedor" TEXT;
