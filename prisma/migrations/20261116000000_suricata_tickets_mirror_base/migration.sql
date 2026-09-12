-- suricata-tickets-mirror (Fase A — BE Slice 0, design.md D1/D2/D14) — espejo
-- local de tickets de Suricata Cx (sistema ajeno, sin REST API) + veredicto
-- del bot. 7 tablas nuevas, TODO ADITIVO: ninguna FK toca una tabla existente
-- salvo SuricataTicket.assigneeId → RbacUser (asignación INTERNA de
-- Prominense, JAMÁS escrita a Suricata — proposal.md, out of scope).
--
-- Generado SIN base de datos local (regla WORKFLOW-MULTI-REPO.md §Migraciones):
--   npx prisma migrate diff --from-schema <schema en HEAD> \
--                           --to-schema prisma/schema.prisma --script
--
-- Al SQL del diff se le apenda a mano (el diff no emite DML):
--   1. Seed RBAC del módulo 'suricata' (D2) — calcado 1:1 del bloque 'store'
--      (20261106000000_store/migration.sql): 'read'/'manage' base + 'reply'
--      DEDICADA (RBAC-EXT-2 — NO se reusa 'send', ver design.md D2 corrección
--      post-tasks 2026-09-11).
--   2. Los 2 feature flags que gobiernan el rollout dark (D14):
--      'suricata-sync-enabled' y 'suricata-reply-enabled', ambos en FALSE.
--      Nacen de la migración (molde 20261028000000_iclass_gps_ingest_flag):
--      SetFeatureFlag hace `update`, no `upsert` — sin esta fila, la card del
--      FE 404ea para siempre.
--
-- Sin BEGIN/COMMIT explícito — Prisma envuelve cada migración en su propia
-- transacción (regla explícita en 20261028000000_iclass_gps_ingest_flag).
-- Todo el seed es ON CONFLICT DO NOTHING (idempotente, re-run seguro).

-- CreateTable
CREATE TABLE "SuricataArea" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SuricataArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuricataTicket" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "priority" TEXT,
    "areaId" TEXT,
    "customerName" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "externalClientRef" TEXT,
    "clientId" TEXT,
    "openedAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3),
    "assigneeId" TEXT,
    "contentHash" TEXT NOT NULL,
    "firstSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SuricataTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuricataMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "authorKind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SuricataMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuricataAttachment" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "messageId" TEXT,
    "externalRef" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "sizeBytes" INTEGER,
    "sha256" TEXT,
    "storageKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "SuricataAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuricataTicketVerdict" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "resuelto" BOOLEAN NOT NULL,
    "analisis" TEXT NOT NULL,
    "motivo" TEXT,
    "respuestaSugerida" TEXT,
    "ticketContentHash" TEXT NOT NULL,
    "submittedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuricataTicketVerdict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuricataReplyAudit" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "error" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "SuricataReplyAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuricataSyncRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "outcome" TEXT NOT NULL DEFAULT 'running',
    "ticketsSeen" INTEGER NOT NULL DEFAULT 0,
    "ticketsUpserted" INTEGER NOT NULL DEFAULT 0,
    "messagesUpserted" INTEGER NOT NULL DEFAULT 0,
    "attachmentsStored" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "selectorMisses" JSONB,

    CONSTRAINT "SuricataSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SuricataArea_externalId_key" ON "SuricataArea"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "SuricataTicket_externalId_key" ON "SuricataTicket"("externalId");

-- CreateIndex
CREATE INDEX "SuricataTicket_status_lastMessageAt_idx" ON "SuricataTicket"("status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "SuricataTicket_areaId_idx" ON "SuricataTicket"("areaId");

-- CreateIndex
CREATE INDEX "SuricataTicket_assigneeId_idx" ON "SuricataTicket"("assigneeId");

-- CreateIndex
CREATE INDEX "SuricataTicket_clientId_idx" ON "SuricataTicket"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "SuricataMessage_externalId_key" ON "SuricataMessage"("externalId");

-- CreateIndex
CREATE INDEX "SuricataMessage_ticketId_sentAt_idx" ON "SuricataMessage"("ticketId", "sentAt");

-- CreateIndex
CREATE INDEX "SuricataAttachment_status_attempts_idx" ON "SuricataAttachment"("status", "attempts");

-- CreateIndex
CREATE UNIQUE INDEX "SuricataAttachment_ticketId_externalRef_key" ON "SuricataAttachment"("ticketId", "externalRef");

-- CreateIndex
CREATE INDEX "SuricataTicketVerdict_ticketId_createdAt_idx" ON "SuricataTicketVerdict"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "SuricataReplyAudit_ticketId_attemptedAt_idx" ON "SuricataReplyAudit"("ticketId", "attemptedAt");

-- CreateIndex
CREATE INDEX "SuricataSyncRun_startedAt_idx" ON "SuricataSyncRun"("startedAt");

-- AddForeignKey
ALTER TABLE "SuricataTicket" ADD CONSTRAINT "SuricataTicket_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "SuricataArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuricataTicket" ADD CONSTRAINT "SuricataTicket_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuricataMessage" ADD CONSTRAINT "SuricataMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SuricataTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuricataAttachment" ADD CONSTRAINT "SuricataAttachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SuricataTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuricataAttachment" ADD CONSTRAINT "SuricataAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "SuricataMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuricataTicketVerdict" ADD CONSTRAINT "SuricataTicketVerdict_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SuricataTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuricataReplyAudit" ADD CONSTRAINT "SuricataReplyAudit_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SuricataTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Seed: módulo RBAC 'suricata' + permisos + grants (calcado de 'store', D2) ───

-- 1. Módulo
INSERT INTO "RbacModule" ("id", "code", "label")
VALUES (gen_random_uuid(), 'suricata', 'Suricata (tickets)')
ON CONFLICT ("code") DO NOTHING;

-- 2. Permiso suricata.read
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'read'
FROM "RbacModule" m
WHERE m."code" = 'suricata'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 3. Permiso suricata.manage
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'manage'
FROM "RbacModule" m
WHERE m."code" = 'suricata'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 4. Permiso suricata.reply (RBAC-EXT-2 — acción DEDICADA, NO reusa 'send')
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'reply'
FROM "RbacModule" m
WHERE m."code" = 'suricata'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 5. Grant suricata.read → los 6 roles de sistema (calcado de store.read)
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" IN ('super_admin', 'administrador', 'administracion', 'ventas', 'noc', 'tecnico')
  AND m."code" = 'suricata'
  AND p."action" = 'read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- 6. Grant suricata.manage → super_admin + administrador (calcado de store.manage)
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" IN ('super_admin', 'administrador')
  AND m."code" = 'suricata'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- 7. Grant suricata.reply → super_admin + administrador (D2: mismo alcance que
--    manage — responder a un cliente real es tan sensible como administrar el módulo).
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" IN ('super_admin', 'administrador')
  AND m."code" = 'suricata'
  AND p."action" = 'reply'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── Seed: feature flags del rollout dark (D14) — nacen apagados ───

INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('suricata-sync-enabled', false, NOW())
ON CONFLICT DO NOTHING;

INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('suricata-reply-enabled', false, NOW())
ON CONFLICT DO NOTHING;
