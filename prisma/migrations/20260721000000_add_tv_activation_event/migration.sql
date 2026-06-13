-- AddTable #5 BE: TvActivationEvent — append-only TV alta/baja/reactivacion log.
-- actorId is a soft FK (SetNull on RbacUser delete) so history survives user deletion.
-- clientId cascades on Client delete.

CREATE TABLE "tv_activation_events" (
    "id"         TEXT NOT NULL,
    "clientId"   TEXT NOT NULL,
    "actorId"    TEXT,
    "actorName"  TEXT NOT NULL,
    "eventType"  TEXT NOT NULL,
    "cic"        TEXT,
    "internalId" TEXT,
    "seq"        INTEGER,
    "contractId" TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tv_activation_events_pkey" PRIMARY KEY ("id")
);

-- Indexes: per-client history (newest-first) + per-actor lookup
CREATE INDEX "tv_activation_events_clientId_createdAt_idx" ON "tv_activation_events"("clientId", "createdAt" DESC);
CREATE INDEX "tv_activation_events_actorId_idx" ON "tv_activation_events"("actorId");

-- FK: clientId → Client (Cascade)
ALTER TABLE "tv_activation_events" ADD CONSTRAINT "tv_activation_events_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK: actorId → RbacUser (SetNull — history readable after user deletion)
ALTER TABLE "tv_activation_events" ADD CONSTRAINT "tv_activation_events_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
