-- persist-caller-id: MAC del CPE persistida (sobrevive a la desconexión).
-- Columna nullable, sin default → zero-downtime. No la pisa el sync (upsertByUsername usa lista explícita).
ALTER TABLE "PppoeService" ADD COLUMN "callerId" TEXT;
