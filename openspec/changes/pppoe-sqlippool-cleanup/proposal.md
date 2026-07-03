# Proposal: Remover el código muerto del sqlippool (descartado)

## Intent

El feature sqlippool ("la IP sigue al NAS" dinámica) fue **DESCARTADO** — su objetivo se cumplió por otro camino (move-nas + watcher + pre-provisión, todo EN PROD, IP FIJA no dinámica). Pero dejó **código DORMANT en prod** (BE `83e1c245` + FE `718081a4`, migración `20260822000000`). Este cambio lo REMUEVE.

## Por qué ahora (no es solo prolijidad)

Verificado en prod (2026-07-02): **0 NAS con `poolName`**, los **3986 PppoeService son `ipMode='fixed'`** → 100% dormant. Pero hay una pieza **VISIBLE con riesgo latente**: en el panel de Internet de CADA cliente hay un botón **"Liberar (volver al pool)"** (`IpAssignmentSection` + `usePinPppoeIp`/`useUnpinPppoeIp`). Hoy da 409 graceful (ningún NAS es pool-mode). PERO si alguien setea un `poolName` en un NAS pensando que hace algo, ese botón **le saca la IP fija a un cliente** → su Ubiquiti queda inalcanzable = lo OPUESTO al requisito. Bomba dormida + deuda de UX.

## Qué se remueve (muerto) vs qué se conserva (vivo)

**REMOVER:**
- **FE**: `IpAssignmentSection` (toggle "IP fija"/"Liberar (volver al pool)") en `InternetPanel` + hooks `usePinPppoeIp`/`useUnpinPppoeIp` + métodos del api client.
- **BE use cases**: `PinPppoeIp`, `UnpinPppoeIp`, `SetNasPoolMode` + sus rutas (`POST /pppoe/:id/pin-ip`, `/unpin-ip`, `/nas-servers/:id/pool-mode`) + tests.
- **BE schema**: `NasServer.poolName` (migración DROP COLUMN — todo null) + su presencia en entidad/DTO/Prisma/InMemory/nas.routes.
- **BE lógica pool-mode**: la rama "pool" en `CreatePppoeService`/`CreatePppoeStandalone` (`nas.poolName != null` → siempre falso → siempre 'fixed', se simplifica a fixed directo) + el guard `PppoePublicIpPoolModeError`/`PPPOE_PUBLIC_IP_POOL_MODE` (dependía de pool-mode → queda inalcanzable).
- Errores tipados huérfanos + wiring en `app.ts` + pins de composición.

**CONSERVAR (VIVO — no tocar):**
- **`PppoeService.ipMode`** (siempre 'fixed' hoy): lo leen/escriben move-nas y pre-provisión + el badge del FE. Removerlo ripplearía por ~10 archivos con cero beneficio. Se queda (queda como constante 'fixed').
- **`orchestrator.changeFramedIp`**: lo usan move-nas, pre-provisión Y el edit. Solo se van los CALLERS pin/unpin.
- **`UpdatePppoeService.remoteAddress`**: el camino de fijar IP a mano se conserva (VERIFICADO: `changeFramedIp`). Sacar Pin no pierde capacidad.

## Fuera de scope

- El param `pool?` de `syncPlan` en el gateway del orchestrator + la lógica `Framed-Pool` del repo `freeradius-orchestrator` (Python, AAA prod) — residual cross-repo, se documenta como deuda menor (no toca AAA).
- `ipMode` (se conserva).

## Scope

- **BE**: migración DROP `poolName` + remoción de 3 use cases + rutas + simplificación del create + limpieza de errores/wiring/tests.
- **FE**: remoción del `IpAssignmentSection` + hooks + api.

## Proceso

SDD + worktrees BE+FE + TDD (los tests que se van se BORRAN; los que quedan deben seguir verdes SIN ajustes) + review adversarial (foco: NO romper move-nas/pre-provisión) + push con validaciones. Migración DROP COLUMN es metadata-only en PG (columna 100% null) → segura.
