-- portal-notification-inbox — el buzón del portal. Cada aviso enviado
-- (SendPushServiceAlert) se persiste como 1 fila POR CUENTA destinataria,
-- tenga o no token de push vivo — respaldo para el cliente que negó el
-- permiso de notificaciones o perdió el token (el push, sin esto, se pierde
-- para siempre si el cliente no lo toca en el momento).
--
-- Additive only: 1 CREATE TABLE + index + FK (Cascade), no DROP, no backfill
-- de datos existentes. Sin seed RBAC — es una tabla client-facing (portal),
-- no admin.

-- CreateTable
CREATE TABLE "PortalNotification" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "PortalNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortalNotification_accountId_sentAt_idx" ON "PortalNotification"("accountId", "sentAt");

-- AddForeignKey
ALTER TABLE "PortalNotification" ADD CONSTRAINT "PortalNotification_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PortalAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
