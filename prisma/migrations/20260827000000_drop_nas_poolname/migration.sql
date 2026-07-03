-- sqlippool-cleanup: el modo pool ("la IP sigue al NAS" dinámica) fue DESCARTADO.
-- La columna NasServer.poolName quedó 100% NULL en prod (0 NAS en modo pool) → drop metadata-only.
-- El objetivo (IP fija que sigue al cliente) se cumple por move-nas + watcher + pre-provisión.
ALTER TABLE "NasServer" DROP COLUMN "poolName";
