-- Cambio A — limpieza de duplicados pre-existentes de ContractInstalledItem.
--
-- Migración de TRANSFORMACIÓN DE DATOS, escrita a mano (excepción justificada a la
-- regla "no editar SQL a mano"). Colapsa las filas duplicadas por (contractId, MAC
-- normalizada) a UN keeper, mergeando los campos faltantes, y BORRA las sobrantes.
-- Con GUARD: si algún grupo no colapsa, RAISE EXCEPTION → rollback total, prod intacto.
--
-- NO lleva BEGIN/COMMIT de primer nivel: `prisma migrate deploy` ya envuelve cada
-- migración en su propia transacción (gotcha 2026-06-10). Es IDEMPOTENTE / no-op si no
-- hay duplicados. La normalización de MAC espeja `normMac` del runtime (upper + sin `:`/`-`).

-- 1) Observabilidad: cuántos grupos duplicados hay (queda en el log del deploy).
DO $$
DECLARE g int;
BEGIN
  SELECT count(*) INTO g FROM (
    SELECT "contractId", regexp_replace(upper("mac"), '[:\-]', '', 'g') AS nmac
    FROM "ContractInstalledItem"
    WHERE "mac" IS NOT NULL
    GROUP BY 1, 2
    HAVING count(*) > 1
  ) d;
  RAISE NOTICE 'dedup_contract_equipment: % grupos (contractId, mac) duplicados encontrados', g;
END $$;

-- 2) Rankear cada fila dentro de su grupo (contractId, mac normalizada). keeper = rn 1.
--    Orden: ACTIVO primero, después el que YA tiene activo (assetId), después el más
--    viejo (createdAt) y id como desempate determinístico.
CREATE TEMP TABLE _cie_rank ON COMMIT DROP AS
SELECT
  id,
  "contractId",
  regexp_replace(upper("mac"), '[:\-]', '', 'g') AS nmac,
  row_number() OVER (
    PARTITION BY "contractId", regexp_replace(upper("mac"), '[:\-]', '', 'g')
    ORDER BY (status = 'active') DESC, ("assetId" IS NOT NULL) DESC, "createdAt" ASC, id ASC
  ) AS rn
FROM "ContractInstalledItem"
WHERE "mac" IS NOT NULL;

-- Mapa loser -> keeper (solo grupos con > 1 fila).
CREATE TEMP TABLE _cie_map ON COMMIT DROP AS
SELECT d.id AS loser_id, k.id AS keeper_id
FROM _cie_rank d
JOIN _cie_rank k ON k."contractId" = d."contractId" AND k.nmac = d.nmac AND k.rn = 1
WHERE d.rn > 1;

-- 3) Merge: rellenar SOLO los campos NULL del keeper con el primer valor no-nulo de sus
--    losers (ordenados por createdAt). NO se pisan los datos que el keeper ya tiene.
UPDATE "ContractInstalledItem" keeper
SET
  "serialNumber"  = COALESCE(keeper."serialNumber",  agg.serial_number),
  "model"         = COALESCE(keeper."model",         agg.model),
  "assetId"       = COALESCE(keeper."assetId",        agg.asset_id),
  "notes"         = COALESCE(keeper."notes",          agg.notes),
  "addedByUserId" = COALESCE(keeper."addedByUserId",  agg.added_by_user_id),
  "confirmedAt"   = COALESCE(keeper."confirmedAt",    agg.confirmed_at),
  "updatedAt"     = now()
FROM (
  SELECT
    m.keeper_id,
    (array_remove(array_agg(c."serialNumber"  ORDER BY c."createdAt"), NULL))[1] AS serial_number,
    (array_remove(array_agg(c."model"         ORDER BY c."createdAt"), NULL))[1] AS model,
    (array_remove(array_agg(c."assetId"       ORDER BY c."createdAt"), NULL))[1] AS asset_id,
    (array_remove(array_agg(c."notes"         ORDER BY c."createdAt"), NULL))[1] AS notes,
    (array_remove(array_agg(c."addedByUserId" ORDER BY c."createdAt"), NULL))[1] AS added_by_user_id,
    (array_remove(array_agg(c."confirmedAt"   ORDER BY c."createdAt"), NULL))[1] AS confirmed_at
  FROM _cie_map m
  JOIN "ContractInstalledItem" c ON c.id = m.loser_id
  GROUP BY m.keeper_id
) agg
WHERE keeper.id = agg.keeper_id;

-- 4) Repuntar las referencias self-FK (replacesItemId) de un loser hacia su keeper, sin
--    crear auto-referencia. Lo que no se repunte, el FK onDelete:SetNull lo limpia al borrar.
UPDATE "ContractInstalledItem" c
SET "replacesItemId" = m.keeper_id
FROM _cie_map m
WHERE c."replacesItemId" = m.loser_id
  AND c.id <> m.keeper_id;

-- 5) Borrar las filas sobrantes (los losers).
DELETE FROM "ContractInstalledItem" WHERE id IN (SELECT loser_id FROM _cie_map);

-- 6) GUARD: si quedó algún grupo con > 1 fila, abortar todo (rollback, prod intacto).
DO $$
DECLARE g int;
BEGIN
  SELECT count(*) INTO g FROM (
    SELECT "contractId", regexp_replace(upper("mac"), '[:\-]', '', 'g') AS nmac
    FROM "ContractInstalledItem"
    WHERE "mac" IS NOT NULL
    GROUP BY 1, 2
    HAVING count(*) > 1
  ) d;
  IF g > 0 THEN
    RAISE EXCEPTION 'dedup_contract_equipment: quedan % grupos duplicados tras el merge — ABORTANDO (rollback)', g;
  END IF;
  RAISE NOTICE 'dedup_contract_equipment: OK, no quedan grupos (contractId, mac) duplicados';
END $$;
