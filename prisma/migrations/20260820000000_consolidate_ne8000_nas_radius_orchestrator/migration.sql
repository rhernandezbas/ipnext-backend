-- Migrate (expand-contract, paso 2): renombra el NasType legacy + consolida las 2 entradas del NE8000.
--
-- Contexto: el `type` 'mikrotik_radius' es engañoso (se usa para el BRAS Huawei NE8000) -> 'radius_orchestrator'.
--   El codigo BE+FE ya acepta AMBOS valores (paso Expand, ya deployado y vivo) -> este UPDATE es seguro.
-- Ademas habia 2 NasServer apuntando al MISMO NE8000 (ipAddress 10.75.0.30): "MercAccesoSur"
--   (mikrotik_radius, donde cuelgan los 194 PppoeServices) y "NE8000-1" (huawei_radius, vacia,
--   creada por 20260812000100). Se consolidan en una sola "NE8000 - Acceso Sur".
-- Bonus: el sobreviviente tenia nasIpAddress STALE (10.60.0.38, el MikroTik viejo) -> se corrige a
--   10.75.0.30 para que ListNe8000PppoeAudit (resuelve por nasIpAddress) apunte a la fila con los 194.
--
-- Idempotente + guarded (fail-fast, rollback total si los supuestos no se cumplen -> prod intacto).
-- En un entorno sin estas filas (dev/fresh) es no-op.

DO $$
DECLARE
  v_dup_id       text;
  v_dup_clients  int;
  v_survivor_id  text;
  v_survivor_cnt int;
BEGIN
  -- 1) Rename global del type legacy -> canonico. El codigo ya acepta ambos (expand vivo).
  UPDATE "NasServer" SET type = 'radius_orchestrator' WHERE type = 'mikrotik_radius';

  -- 2) Consolidacion del NE8000: solo si existe el duplicado huawei_radius en 10.75.0.30.
  SELECT id INTO v_dup_id
    FROM "NasServer"
    WHERE type = 'huawei_radius' AND "ipAddress" = '10.75.0.30'
    LIMIT 1;

  IF v_dup_id IS NULL THEN
    RAISE NOTICE 'Sin duplicado huawei_radius@10.75.0.30 -> consolidacion omitida (no-op).';
    RETURN;
  END IF;

  -- Guard verify-before-delete: el duplicado NO debe tener PppoeServices.
  SELECT COUNT(*) INTO v_dup_clients FROM "PppoeService" WHERE "nasId" = v_dup_id;
  IF v_dup_clients > 0 THEN
    RAISE EXCEPTION 'Abort: el duplicado huawei_radius (%) tiene % PppoeServices -> NO se borra.', v_dup_id, v_dup_clients;
  END IF;

  -- Sobreviviente: el NAS radius_orchestrator en 10.75.0.30 (donde estan los 194 PppoeServices).
  SELECT id INTO v_survivor_id
    FROM "NasServer"
    WHERE type = 'radius_orchestrator' AND "ipAddress" = '10.75.0.30'
    LIMIT 1;

  IF v_survivor_id IS NULL THEN
    RAISE EXCEPTION 'Abort: no se encontro el NAS sobreviviente radius_orchestrator@10.75.0.30.';
  END IF;

  SELECT COUNT(*) INTO v_survivor_cnt FROM "PppoeService" WHERE "nasId" = v_survivor_id;
  RAISE NOTICE 'Consolidando NE8000: sobreviviente % (% PppoeServices), borra duplicado vacio %.',
    v_survivor_id, v_survivor_cnt, v_dup_id;

  -- Corrige nasIpAddress stale (MikroTik viejo -> NE8000) y renombra claro.
  UPDATE "NasServer"
    SET "nasIpAddress" = '10.75.0.30',
        name           = 'NE8000 - Acceso Sur'
    WHERE id = v_survivor_id;

  -- Borra el duplicado vacio.
  DELETE FROM "NasServer" WHERE id = v_dup_id;
END $$;
