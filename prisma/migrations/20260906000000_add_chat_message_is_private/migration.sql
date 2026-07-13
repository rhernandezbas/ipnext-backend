-- messaging-inbox-notes (F1.5 fase D, NOTE-1) — columna aditiva, sin backfill.
-- Nunca hubo filas históricas de nota privada: F1 siempre las descartó (nunca
-- persistidas), así que no hay datos viejos que reinterpretar.
ALTER TABLE "ChatMessage" ADD COLUMN "isPrivate" BOOLEAN NOT NULL DEFAULT false;
