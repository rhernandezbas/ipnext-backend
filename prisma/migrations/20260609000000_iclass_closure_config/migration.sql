-- AddTable: IClassClosureConfig (singleton row, additive, no seed)
CREATE TABLE "IClassClosureConfig" (
    "id"                     VARCHAR NOT NULL DEFAULT 'singleton',
    "closureIntervalMs"      INTEGER NOT NULL DEFAULT 600000,
    "autocompleteIntervalMs" INTEGER NOT NULL DEFAULT 900000,
    "updatedAt"              TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IClassClosureConfig_pkey" PRIMARY KEY ("id")
);
