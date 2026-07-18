-- N2 — adjuntos en Noticias (media/link) + registro de difusión al NOC.
-- Aditivo: 1 ALTER (columna nullable) + 1 CREATE TABLE + index + FK Cascade. Sin DROP, sin backfill.
-- No BEGIN/COMMIT (Prisma envuelve cada migración en su propia transacción).

-- AlterTable: registro de la última difusión al NOC (nullable — filas históricas quedan NULL).
ALTER TABLE "NewsPost" ADD COLUMN "lastBroadcastAt" TIMESTAMP(3);

-- CreateTable: adjunto de noticia (binario en storage bajo storageKey, o link externo por url).
CREATE TABLE "NewsPostAttachment" (
    "id" TEXT NOT NULL,
    "newsPostId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storageKey" TEXT,
    "filename" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "url" TEXT,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NewsPostAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NewsPostAttachment_newsPostId_idx" ON "NewsPostAttachment"("newsPostId");

-- AddForeignKey: borrar la noticia borra sus adjuntos (el binario lo limpia el use case vía FileStorage).
ALTER TABLE "NewsPostAttachment" ADD CONSTRAINT "NewsPostAttachment_newsPostId_fkey" FOREIGN KEY ("newsPostId") REFERENCES "NewsPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
