-- CreateTable
CREATE TABLE "AssistantProfile" (
    "id" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "persona" TEXT NOT NULL DEFAULT '',
    "handoffMessage" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT 'deepseek-chat',
    "classifierModel" TEXT,
    "timeoutMs" INTEGER NOT NULL DEFAULT 20000,
    "enabledActions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantIntent" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "examples" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "dataSourceKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "responseGuide" TEXT NOT NULL DEFAULT '',
    "actionKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantDataSource" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantDataSource_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AssistantAction" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantAction_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AssistantRoutingConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "defaultAreaId" TEXT,
    "rerouteEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantRoutingConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantEvalRun" (
    "id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "resolutionTotal" INTEGER NOT NULL,
    "resolutionCorrect" INTEGER NOT NULL,
    "abstentionTotal" INTEGER NOT NULL,
    "abstentionCorrect" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantEvalRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantRun" (
    "id" TEXT NOT NULL,
    "profileId" TEXT,
    "areaId" TEXT,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "intentName" TEXT,
    "dataSources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "actionKey" TEXT,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AssistantProfile_areaId_key" ON "AssistantProfile"("areaId");

-- CreateIndex
CREATE INDEX "AssistantIntent_profileId_idx" ON "AssistantIntent"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "AssistantIntent_profileId_name_key" ON "AssistantIntent"("profileId", "name");

-- CreateIndex
CREATE INDEX "AssistantEvalRun_createdAt_idx" ON "AssistantEvalRun"("createdAt");

-- CreateIndex
CREATE INDEX "AssistantRun_subjectType_subjectId_idx" ON "AssistantRun"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "AssistantRun_createdAt_idx" ON "AssistantRun"("createdAt");

-- AddForeignKey
ALTER TABLE "AssistantProfile" ADD CONSTRAINT "AssistantProfile_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "TicketAreaCatalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantIntent" ADD CONSTRAINT "AssistantIntent_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "AssistantProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantRoutingConfig" ADD CONSTRAINT "AssistantRoutingConfig_defaultAreaId_fkey" FOREIGN KEY ("defaultAreaId") REFERENCES "TicketAreaCatalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- Seed IDEMPOTENTE de los catálogos (regla 5 del workflow: el deploy corre
-- `migrate deploy` pero NO `prisma db seed`, así que los datos canónicos deben
-- bootstrappearse acá). Patrón ON CONFLICT (columna) DO NOTHING.
-- ─────────────────────────────────────────────────────────────────────────────

-- CFG-3 — catálogo de FUENTES DE DATOS. La implementación de cada key vive en
-- código (AssistantDataSourceRegistry). Acá sólo se habilita/deshabilita.
INSERT INTO "AssistantDataSource" ("key", "label", "enabled", "updatedAt") VALUES
  ('cliente.saldo',    'Saldo y vencimiento',            true,  CURRENT_TIMESTAMP),
  ('cliente.servicio', 'Estado del servicio y plan',     true,  CURRENT_TIMESTAMP),
  ('os.abiertas',      'Órdenes de servicio abiertas',   true,  CURRENT_TIMESTAMP),
  -- D2 — arranca DESHABILITADA a propósito: mientras el hub NOC esté en modo
  -- oscuro, responder "no hay cortes en tu zona" sería afirmar sin saber, que es
  -- justo el modo de falla que este change combate. Se prende con un tilde
  -- cuando el hub salga a producción.
  ('noc.cortes',       'Cortes activos en la zona',      false, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- CFG-3 / ACT-2 — catálogo de ACCIONES con su nivel de riesgo. TODAS operan sobre
-- la CONVERSACIÓN de Chatwoot: los agentes humanos trabajan DENTRO de Chatwoot, no
-- en el inbox de Prominense, así que todo lo que el bot hace tiene que ser visible
-- ahí (nota privada / label / estado). Una marca que sólo viva en nuestra base no
-- la ve nadie.
-- Ninguna acción se habilita acá: `AssistantProfile.enabledActions` nace vacío, así
-- que una instalación nueva tiene CERO acciones activas (test T8.4).
INSERT INTO "AssistantAction" ("key", "label", "riskLevel", "updatedAt") VALUES
  ('private_note',         'Dejar nota privada en Chatwoot',        'green',  CURRENT_TIMESTAMP),
  ('apply_label',          'Etiquetar la conversación',             'green',  CURRENT_TIMESTAMP),
  ('suggest_area',         'Reclasificar el área',                  'green',  CURRENT_TIMESTAMP),
  ('whatsapp_reply',       'Responder al cliente por WhatsApp',     'yellow', CURRENT_TIMESTAMP),
  -- 🔴 Marcar resuelta una conversación cuyo pedido seguía vivo entierra el reclamo
  -- y el cliente queda sin respuesta. Requiere eval registrado (EVAL-2).
  ('resolve_conversation', 'Marcar la conversación como resuelta',  'red',    CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- RUN-4 — kill-switch GLOBAL del asistente, independiente del `enabled` de cada perfil.
-- Seed en FALSE: el deploy de este change no debe cambiar ni un byte del comportamiento
-- observable en producción (dark launch). Se lee POR INVOCACIÓN, no cacheado al boot, así
-- que apagarlo corta todo en caliente sin reiniciar el proceso.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('ai-assistant-enabled', false, NOW())
ON CONFLICT DO NOTHING;

-- RTR-0 — fila singleton del ruteo. `defaultAreaId` arranca en NULL a propósito: sin agente
-- default, las conversaciones que entran sin área NO se atienden. Es el comportamiento
-- seguro (silencio) en vez de que un agente recién instalado empiece a contestarle a todo el
-- mundo por el solo hecho de existir. El operador elige el área default cuando esté listo.
INSERT INTO "AssistantRoutingConfig" ("id", "defaultAreaId", "rerouteEnabled", "updatedAt")
VALUES ('singleton', NULL, false, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
