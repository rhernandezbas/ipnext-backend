# Spec: pppoe-sqlippool-cleanup

## REQ-DEL-1 — Rutas pin/unpin/pool-mode eliminadas

`POST /api/pppoe/:id/pin-ip`, `/unpin-ip` y `/nas-servers/:id/pool-mode` NO existen más → 404 (route not found), NO 401/403/otro handler.

- S1.1 `POST /pppoe/x/pin-ip` → 404 (ruta inexistente).
- S1.2 `POST /nas-servers/x/pool-mode` → 404.

## REQ-DEL-2 — `poolName` fuera del modelo NAS

`NasServer` no expone `poolName`; el DTO de NAS tampoco; la columna se dropea por migración.

- S2.1 `GET /api/nas-servers` → los items NO tienen `poolName`.
- S2.2 la migración DROP COLUMN es metadata-only (snapshot test), timestamp posterior a la última.

## REQ-DEL-3 — Creación siempre `ipMode='fixed'` (sin rama pool)

Toda creación radius persiste `ipMode='fixed'`; no hay camino que produzca `'pool'`. El guard `PPPOE_PUBLIC_IP_POOL_MODE` no existe (era inalcanzable).

- S3.1 crear con NAS + cualquier `ipTypePreference` → `ipMode='fixed'` (regresión, sin cambios de comportamiento).
- S3.2 pre-provisión (sin NAS) → `ipMode='fixed'` (regresión).
- S3.3 crear 'public' en cualquier NAS → NO da `PPPOE_PUBLIC_IP_POOL_MODE` (ese código ya no existe).

## REQ-KEEP-1 — Fijar IP a mano se conserva

Editar un servicio con `remoteAddress` nueva DEBE seguir llamando `changeFramedIp` y persistiéndola (el reemplazo de la capacidad de "pin").

- S4.1 `PATCH /pppoe/:id` con `remoteAddress` nueva → `changeFramedIp(username, ip)` + persistido.

## REQ-KEEP-2 — move-nas y pre-provisión intactos

`MovePppoeToNas`, `AutoMovePppoe` y el flujo de creación/adopción siguen funcionando idénticos; sus tests pasan SIN ajustes de asserts.

- S5.1 move radius→radius → IP nueva del pool cgnat + `ipMode='fixed'` (regresión verde).
- S5.2 adopción de un pendiente → NAS real + IP fija (regresión verde).

## REQ-FE-1 — Panel sin el toggle pin/unpin, IP visible

El `InternetPanel` NO muestra el botón "Liberar (volver al pool)" ni el input de pin; la IP del servicio SIGUE visible (solo lectura).

- S6.1 render del panel de un servicio con IP → la IP se muestra; NO hay botón "Liberar".
- S6.2 no quedan imports/hooks de `usePinPppoeIp`/`usePppoeIp` (dead-import guard por tsc).
