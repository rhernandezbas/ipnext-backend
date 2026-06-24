-- Backfill: canonizar Contract.status de los valores crudos de Gestión Real al enum canónico.
-- Valores reales en GR: 'Vigente'(->active), 'Baja'(->baja), 'Pendiente de Instalación'(->new, cazado por el guard en el 1er deploy 2026-06-24).
-- Variantes anticipadas incluidas por robustez. Guard fail-fast: si tras el backfill queda
-- CUALQUIER valor no canónico, aborta (RAISE EXCEPTION => rollback total, prod intacto).

UPDATE "Contract" SET status = 'active'
  WHERE lower(btrim(status)) IN ('vigente','activo','activa','active');

UPDATE "Contract" SET status = 'baja'
  WHERE lower(btrim(status)) IN ('baja','dado de baja','de baja');

UPDATE "Contract" SET status = 'inactive'
  WHERE lower(btrim(status)) IN ('inactivo','inactiva','inactive');

UPDATE "Contract" SET status = 'blocked'
  WHERE lower(btrim(status)) IN ('suspendido','suspendida','bloqueado','bloqueada','blocked');

UPDATE "Contract" SET status = 'new'
  WHERE lower(btrim(status)) IN ('pendiente de instalación','pendiente de instalacion','pendiente','nuevo','new');

DO $$
DECLARE rogue text; cnt int;
BEGIN
  SELECT count(*) INTO cnt FROM "Contract"
    WHERE status NOT IN ('active','inactive','blocked','baja','new');
  IF cnt > 0 THEN
    SELECT string_agg(DISTINCT status, ', ') INTO rogue FROM "Contract"
      WHERE status NOT IN ('active','inactive','blocked','baja','new');
    RAISE EXCEPTION 'Backfill Contract.status: % filas con estado no mapeado: [%]. Abortado (prod intacto). Agregar el mapeo y reintentar.', cnt, rogue;
  END IF;
END $$;
