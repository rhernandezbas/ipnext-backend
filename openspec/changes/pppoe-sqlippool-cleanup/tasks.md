# Tasks: pppoe-sqlippool-cleanup

> Remoción de código muerto. TDD adaptado: los tests del código que se va se BORRAN; los que quedan (move-nas, pre-provisión, create fixed, edit) deben seguir VERDES SIN ajustar asserts. Review con foco en NO romper lo shippeado.

## BE (worktree `pppoe-sqlippool-cleanup-be`)

- [ ] 1.1 Borrar rutas pin-ip/unpin-ip (`pppoe.routes.ts`) + pool-mode (`nas.routes.ts`) + sus tests (`pppoe.pin-ip.routes.test.ts`, `nas.pool-mode.routes.test.ts`). Tests RED-inverso S1.1/S1.2 (404).
- [ ] 1.2 Borrar use cases `PinPppoeIp`, `UnpinPppoeIp`, `SetNasPoolMode` + tests + wiring en `app.ts` + pins de composición.
- [ ] 1.3 Borrar errores tipados pin/unpin/pool-mode-only de `domain/errors/pppoe.ts` + su mapeo en `errorHandler.ts` (grep cada uno: solo los que NINGÚN use case vivo usa).
- [ ] 1.4 Simplificar `CreatePppoeService`/`CreatePppoeStandalone`: quitar la rama `nas.poolName != null` → `ipMode='fixed'` directo; quitar el guard `PppoePublicIpPoolModeError` (S3.3). Tests de create fixed + pre-provisión verdes SIN ajustes (S3.1/S3.2).
- [ ] 1.5 Quitar `poolName` de `domain/entities/nas.ts` + `PrismaNasRepository` + `InMemoryNasRepository` + DTO NAS + `nas.routes.ts` (S2.1).
- [ ] 1.6 Migración `<ts>_drop_nas_poolname` (`ALTER TABLE "NasServer" DROP COLUMN "poolName";`, sin BEGIN/COMMIT, timestamp posterior a la última) + snapshot test (S2.2).
- [ ] 1.7 Regresión: pin de `ipMode:'fixed'` intacto (S3.1/S3.2/S5.1/S5.2); `UpdatePppoeService.remoteAddress`→changeFramedIp (S4.1). Gate: tsc + suite completa (los tests borrados no cuentan; los vivos verdes).

## FE (worktree `pppoe-sqlippool-cleanup-fe`)

- [ ] 2.1 Borrar `IpAssignmentSection` de `InternetPanel.tsx` + su uso + imports `usePinPppoeIp`/`useUnpinPppoeIp`. Si era el único display de la IP, mover la IP (read-only) al detalle (S6.1).
- [ ] 2.2 Borrar hooks `usePinPppoeIp`/`useUnpinPppoeIp` + métodos `pinIp`/`unpinIp` del api client.
- [ ] 2.3 Borrar/ajustar tests que asertaban el botón "Liberar"; pinear que la IP sigue visible + no hay "Liberar" (S6.1); tsc sin imports muertos (S6.2). Gate: tsc + Vitest TZ=UTC.

## Cierre

- [ ] 3.1 Review adversarial (BE: foco NO romper move-nas/pre-provisión + errores no huérfanos + migración; FE: hueco visual de la IP). Fix waves → CLEAN.
- [ ] 3.2 Push BE→FE (migración DROP COLUMN) + deploys verdes + card BACKLOG (sqlippool → descartado + código removido).
- [ ] 3.3 Archivar el change sqlippool (`openspec/changes/pppoe-pool-ip`) como descartado.
