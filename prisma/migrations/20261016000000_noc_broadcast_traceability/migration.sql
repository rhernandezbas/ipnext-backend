-- noc-broadcast-traceability — quién y cuándo difundió una tarea/noticia al canal NOC.
-- Aditivo: 3 ALTER (columnas nullable). Sin DROP, sin backfill, sin FK — filas históricas quedan NULL.
-- No BEGIN/COMMIT (Prisma envuelve cada migración en su propia transacción).

-- AlterTable: tarea de RED — última difusión al NOC + nombre (snapshot) del actor.
ALTER TABLE "ScheduledTask" ADD COLUMN "lastBroadcastAt" TIMESTAMP(3);
ALTER TABLE "ScheduledTask" ADD COLUMN "lastBroadcastByName" TEXT;

-- AlterTable: noticia — nombre (snapshot) del actor de la última difusión
-- ("lastBroadcastAt" ya existe desde 20261015000000_news_attachments_broadcast).
ALTER TABLE "NewsPost" ADD COLUMN "lastBroadcastByName" TEXT;
