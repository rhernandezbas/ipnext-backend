# Design: pppoe-sqlippool-cleanup

## D1 — Orden de remoción (BE), de la hoja a la raíz

1. **Rutas** `POST /pppoe/:id/pin-ip`, `/pppoe/:id/unpin-ip`, `POST /nas-servers/:id/pool-mode` → borrar de `pppoe.routes.ts` / `nas.routes.ts` + sus tests (`pppoe.pin-ip.routes.test.ts`, `nas.pool-mode.routes.test.ts`).
2. **Use cases** `PinPppoeIp`, `UnpinPppoeIp`, `SetNasPoolMode` + sus tests. Quitar su wiring de `app.ts` + los pins de composición que los referencian.
3. **Errores** en `domain/errors/pppoe.ts` que solo usaban esos use cases (ej. los de pin/unpin/pool-mode) + su mapeo en `errorHandler.ts`. OJO: NO borrar errores que move-nas/pre-provisión usen.
4. **`CreatePppoeService` / `CreatePppoeStandalone`**: la rama pool decide `ipMode` por `nas.poolName != null`. Con `poolName` fuera, esa condición es siempre falsa → **simplificar a `ipMode='fixed'` directo** (el camino que ya corre en prod). Quitar también el guard `PppoePublicIpPoolModeError`/`PPPOE_PUBLIC_IP_POOL_MODE` (era 'public'+pool-mode → inalcanzable sin pool-mode). Los tests de esos guards se BORRAN; los de creación fixed/pre-provisión deben seguir verdes.
5. **`poolName` del modelo**: quitar de `domain/entities/nas.ts` (entidad + toEntity/toRow), `PrismaNasRepository`, `InMemoryNasRepository`, DTO de NAS, y cualquier referencia en `nas.routes.ts`. Migración **DROP COLUMN** al final.
6. **Migración** `<timestamp>_drop_nas_poolname/migration.sql`: `ALTER TABLE "NasServer" DROP COLUMN "poolName";` — metadata-only (100% NULL, verificado en prod), sin backfill, sin BEGIN/COMMIT, timestamp posterior a la última. Snapshot test.

## D2 — Lo que NO se toca (guardas de regresión)

- `PppoeService.ipMode` (columna + entidad + DTO): se queda. Todos los usos actuales lo escriben 'fixed' — no cambia nada. Un test de regresión pinea que create/move/adopción siguen persistiendo `ipMode:'fixed'`.
- `orchestrator.changeFramedIp` (port + gateway + fakes): se queda intacto — es dependencia de move-nas, pre-provisión y el edit.
- `MovePppoeToNas`, `AutoMovePppoe`, `CreatePppoeService` (rama fixed + pre-provisión), `UpdatePppoeService` (remoteAddress→changeFramedIp): sus tests siguen verdes SIN ajustes de asserts. Si alguno referenciaba `poolName` en un fixture, se quita el campo (aditivo inverso), NO se cambia ningún assert de comportamiento.

## D3 — FE

- Borrar el componente `IpAssignmentSection` (el bloque "IP fija: {ip}" + botón "Liberar (volver al pool)" + el input de pin para modo pool) de `InternetPanel.tsx` y su uso (líneas ~1290-1297) + los imports `usePinPppoeIp`/`useUnpinPppoeIp`.
- Borrar los hooks `usePinPppoeIp`/`useUnpinPppoeIp` (de `usePppoe.ts` o donde vivan) + los métodos `pinIp`/`unpinIp` del api client (`pppoe.api.ts`).
- **La IP del servicio sigue siendo VISIBLE** por el resto del panel (el detalle ya muestra la IP del servicio) — solo se va el control de pin/unpin. Verificar que no quede un hueco visual: si el `IpAssignmentSection` era el ÚNICO lugar que mostraba la IP, mover ese display (solo lectura) al detalle; si ya se muestra en otro lado, borrar y listo.
- Tests: borrar los del pin/unpin; ajustar los del panel que asertaban el botón "Liberar" (se van); pinear que la IP sigue visible.

## D4 — Verificación de "nada perdido"

- Fijar IP a mano: cubierto por `UpdatePppoeService.remoteAddress` (editar) + el alta con IP. Un test lo pinea (editar un servicio con remoteAddress nueva → changeFramedIp).
- El pre-provisión/move NO dependían de pin/unpin (usan createUser/changeFramedIp directo) — verificado.

## D5 — Fix wave post-review (2026-07-03)

**Hallazgo del review BE (gap del brief FE inicial):** el sqlippool tenía UI muerta en DOS lugares FE, no uno. Además del toggle del InternetPanel (ya removido), el **modal "Crear PPPoE" del tab** (`PppoeManagementTab.CreatePppoeModal`) tiene un select **"Modo IP"** que default a `'pool'` y manda `ipMode:'pool'` al `POST /pppoe`.

1. **BE — NO narrowing, STRIP:** en vez de `ipMode: z.enum(['fixed'])` (que da 422 a un `'pool'` entrante), **quitar `ipMode` del `CreatePppoeStandaloneBodySchema` por completo**. Los schemas del BE NO son `.strict()` → zod STRIPEA el campo desconocido → un cliente que aún mande `ipMode:'pool'` es ignorado, crea `'fixed'`, **cero 422 y CERO dependencia de orden de deploy**. El use case ya produce siempre `'fixed'` (verificado). Test: `POST /pppoe` con `ipMode:'pool'` → 201 `ipMode='fixed'` (stripeado, no 422).
2. **BE — barrido en cascada** (código sin caller vivo tras borrar los use cases): `RadiusOrchestratorGateway.listPools()` + type `RadiusIpPool` + Http impl + fake; `PppoeServiceRepository.setIpMode()` + Prisma/InMemory impls; comentarios stale que citan `poolName`/`SetNasPoolMode`/"rama pool". Es la MISMA limpieza — se barre ahora.
3. **FE — remover el select "Modo IP"** del modal del tab (`ipMode` state + el `<select id="create-ipmode">` + `ipMode` del body). El create con NAS pasa a: input **"IP fija (opcional)"** (vacía = el BE asigna del pool vía FindFreeIp); el body va `{nasId, ...(framedIp?{framedIp}:{})}` SIN `ipMode`. "Sin router" (pre-provisión) intacto. `crossesSentinel` resetea solo `framedIp`. Comentarios stale (`usePppoe.ts:252`, `pppoe.api.ts:342`). Tests que asertaban `body.ipMode==='pool'` → sin `ipMode`.

Orden de deploy: indistinto (el BE stripea) — igual FE→BE por prolijidad.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Romper la rama create de move-nas/pre-provisión al simplificar el pool branch | tests de create fixed + pre-provisión verdes SIN ajustes; el review lo verifica |
| Borrar un error tipado que otro use case usa | grep de cada error antes de borrar; solo los pin/unpin/pool-mode-only |
| DROP COLUMN sobre datos | 100% NULL verificado en prod; metadata-only en PG; irreversible pero el dato no existe |
| Hueco visual en el panel (la IP dejaba de verse) | D3: confirmar que la IP se muestra en otro lado o mover el display read-only |
| `syncPlan(pool?)` del gateway queda con param muerto | fuera de scope, documentado; no rompe nada (param opcional sin uso) |
