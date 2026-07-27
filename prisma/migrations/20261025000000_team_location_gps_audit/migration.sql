-- CreateTable
CREATE TABLE "TeamLocationPoint" (
    "id" TEXT NOT NULL,
    "teamLogin" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "accuracyM" DOUBLE PRECISION,
    "sources" INTEGER[],
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamLocationPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamLocationIngestRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "teamsProcessed" INTEGER NOT NULL,
    "pointsNew" INTEGER NOT NULL,
    "pointsDuplicate" INTEGER NOT NULL,
    "pointsPurged" INTEGER NOT NULL,
    "pagesRead" INTEGER NOT NULL,
    "pointsDropped" INTEGER NOT NULL DEFAULT 0,
    "incompleteTeams" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamLocationIngestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamLocationIngestState" (
    "id" TEXT NOT NULL,
    "teamLogin" TEXT NOT NULL,
    "contiguousWatermark" TIMESTAMP(3),
    "lastIncompleteAt" TIMESTAMP(3),
    "consecutiveIncomplete" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamLocationIngestState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeamLocationPoint_teamLogin_recordedAt_idx" ON "TeamLocationPoint"("teamLogin", "recordedAt" DESC);

-- CreateIndex
CREATE INDEX "TeamLocationPoint_recordedAt_idx" ON "TeamLocationPoint"("recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TeamLocationPoint_teamLogin_recordedAt_latitude_longitude_key" ON "TeamLocationPoint"("teamLogin", "recordedAt", "latitude", "longitude");

-- CreateIndex
CREATE INDEX "TeamLocationIngestRun_startedAt_idx" ON "TeamLocationIngestRun"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TeamLocationIngestState_teamLogin_key" ON "TeamLocationIngestState"("teamLogin");

