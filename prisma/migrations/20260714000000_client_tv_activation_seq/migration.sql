-- tv-reactivation-sequential (#81) — contador de reactivaciones de TV POR CLIENTE.
-- El partner Gigared QUEMA el internal_id al primer uso (mapeo append-only). Una segunda alta de
-- TV con el mismo Client.id crudo falla ("ID interno ya está en uso"); el mail determinístico (#65)
-- repetido falla ("más de una activación pendiente"). Por eso la identidad de TV es secuencial:
-- seq=0 = identidad de hoy (internal_id = Client.id crudo, mail sin sufijo); cada reactivación
-- post-baja incrementa el seq y produce un internal_id ({id}-{seq}) + mail ({apellido}{grId}{seq})
-- frescos, nunca quemados. La sync de GR NUNCA escribe esta columna — es estado propio del mirror.
-- Aditiva e idempotente, default 0 (back-compat: todos los clientes existentes quedan en seq=0).
-- Prisma wraps each migration in its own transaction; no BEGIN/COMMIT here.

ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "tvActivationSeq" INTEGER NOT NULL DEFAULT 0;
