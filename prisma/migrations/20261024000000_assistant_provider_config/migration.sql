-- CreateTable
CREATE TABLE "AssistantProviderConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "apiKey" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantProviderConfig_pkey" PRIMARY KEY ("id")
);


-- Fila singleton vacía: sin credenciales cargadas, el adapter cae al env var
-- (DEEPSEEK_API_KEY). Cero cambio de comportamiento al aplicar esta migración.
INSERT INTO "AssistantProviderConfig" ("id", "baseUrl", "apiKey", "updatedAt")
VALUES ('singleton', '', '', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
