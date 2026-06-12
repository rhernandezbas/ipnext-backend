-- tv-register-deterministic (#65) — credenciales Gigared Play impactadas en el ContractService TV.
-- Aditiva e idempotente: dos columnas opcionales para el login (GIGA{abonado}) y la contraseña
-- determinística generada en el alta (#65). NO se tocan las notes (el reconcile #47f matchea por
-- prefijo 'CIC '). La password queda visible para el operador por pedido explícito del usuario; el
-- audit middleware la enmascara (campo 'tvPassword' en SENSITIVE_KEYS).
-- Prisma wraps each migration in its own transaction; no BEGIN/COMMIT here.

ALTER TABLE "ContractService" ADD COLUMN IF NOT EXISTS "tvLogin"    TEXT;
ALTER TABLE "ContractService" ADD COLUMN IF NOT EXISTS "tvPassword" TEXT;
