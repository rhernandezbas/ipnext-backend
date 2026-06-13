-- tv-local-cancel-state (#72) — flag local "TV dada de baja" en el mirror de clientes.
-- El partner Gigared NO tiene un primitive de unlink: PATCH /accounts/{cic}/internal_id con ''
-- siempre devuelve HTTP 400. El mapping internal_id↔CIC es append-only en el partner.
-- Por lo tanto, el estado "cliente sin TV" se persiste LOCALMENTE en esta columna.
-- La sync de GR (Gestión Real) NUNCA escribe esta columna — es estado propio del mirror.
-- Aditiva e idempotente. Prisma wraps each migration in its own transaction; no BEGIN/COMMIT here.

ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "tvCancelledAt" TIMESTAMP(3);
