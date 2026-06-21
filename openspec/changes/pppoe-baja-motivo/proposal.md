# Proposal: PPPoE baja/desasociar con MOTIVO + historial "ver"

## Intent

Cuando se da de **baja** o se **desasocia** un PPPoE de un contrato de internet, pedir un **modal de motivo** (obligatorio) y que ese motivo quede en el **historial del contrato** con un link **"ver"** — espejando exactamente cómo funciona TV (`ServiceRemovalReasonModal` + `ReasonViewModal`).

## Why

- Hoy la baja/desasociar de PPPoE NO registra el motivo. Peor: el explore descubrió que **el motivo de la baja tampoco se guarda hoy** por una race — `EnsureInternetContractService` inactiva la línea INTERNET de forma síncrona ANTES de que llegue el PATCH del FE, así que `UpdateContractService` no detecta transición y NO registra el evento.
- TV ya tiene el patrón completo (modal de motivo + evento con `reason` + historial con "ver"). Lo replicamos para PPPoE.

## Scope

### In Scope

**BE — registrar el evento (con motivo + actor) EN EL USE CASE (no por PATCH):**
- `EnsureInternetContractService`: inyectar `ContractServiceEventRepository`; al **inactivar** la línea INTERNET registrar un `ContractServiceEvent` `deactivated` con `reason` + actor; al **activar/reactivar** registrar `activated` (reason null). Aceptar `opts?: { reason?, actorId?, actorName? }`. **Best-effort** (try/catch).
- `DeactivatePppoeService` (baja): aceptar `reason?` + actor → `ensureInternet(contractId, false, { reason, actor })`.
- `DeassociatePppoeFromContract` (desasociar): aceptar `reason?` + actor → `ensureInternet(contractId, false, { reason, actor })`.
- `AssociatePppoeToContract` / `CreatePppoeService`: pasar actor a `ensureInternet(..., true, { actor })` (evento `activated`, reason null) — historial completo del alta.
- Rutas (`pppoe.routes.ts`): `DELETE /pppoe/:id` y `DELETE /contracts/:cid/pppoe/:pppoeId` parsean `reason` del body + actor de `req.user` → al use case.

**FE — modal de motivo en ambas acciones (`InternetPanel.tsx`):**
- **Baja**: el `ServiceRemovalReasonModal` ya está cableado; cambiar `handleBaja(reason)` para mandar el `reason` en el body del `DELETE /pppoe/:id` (sacar el PATCH redundante que era no-op por la race).
- **Desasociar**: reemplazar el confirm plano por `ServiceRemovalReasonModal`; `handleDeassociate(reason)` manda `reason` en el body del `DELETE /contracts/:cid/pppoe/:id`.
- Hooks/api: `useDeactivate`/`useDeassociate` aceptan `reason`.

**Historial "ver"**: ya funciona — `ServiceHistoryModal` renderiza la columna Motivo con "ver" → `ReasonViewModal` para CUALQUIER servicio (incluido INTERNET). Una vez que los eventos se guardan, aparece solo. **Sin cambio.**

### Out of Scope

- El historial/`ReasonViewModal`/`ServiceRemovalReasonModal` (ya genéricos, se reusan tal cual).
- La centralización RADIUS `Mikrotik-Rate-Limit` (ya hecha aparte, ops).

## Capabilities

### Modified Capabilities
- PPPoE lifecycle: baja/desasociar capturan motivo + lo registran en el historial del contrato.

## Approach

1. **BE**: el evento se registra en el use case (vía `ensureInternet`), no por el PATCH del FE → mata la race. TDD.
2. **FE**: cablear el `reason` a los 2 DELETE + swap del confirm de desasociar por el modal de motivo.

## Affected Areas

| Área | Impacto |
|------|---------|
| `EnsureInternetContractService.ts` | Modified — inyecta cseRepo + registra evento (activated/deactivated) best-effort |
| `DeactivatePppoeService.ts` | Modified — `reason?`+actor → ensureInternet |
| `DeassociatePppoeFromContract.ts` | Modified — `reason?`+actor → ensureInternet |
| `AssociatePppoeToContract.ts` / `CreatePppoeService.ts` | Modified — pasan actor a ensureInternet(true) |
| `pppoe.routes.ts` | Modified — parsear reason+actor en los 2 DELETE |
| `app.ts` | Modified — wiring cseRepo en ensureInternet (+ composition test) |
| **FE** `InternetPanel.tsx` + hooks/api PPPoE | Modified — reason en baja+desasociar + modal en desasociar |

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Doble evento (use case + PATCH del FE) | Media | Sacar el PATCH redundante del FE; el evento lo registra SOLO el use case |
| Registrar evento rompe la baja/desasociar | Baja | Best-effort (try/catch + warn); la operación PPPoE nunca falla por el evento |
| Motivo vacío | Baja | El modal exige textarea no-vacío (ya lo hace `ServiceRemovalReasonModal`) |

## Rollback

Aditivo + correcciones contenidas. Rollback = `git revert` (BE+FE).

## Dependencies

- Change A (en prod): `EnsureInternetContractService`, `DeassociatePppoeFromContract`, la línea INTERNET. Sin cambio de schema (los eventos usan `ContractServiceEvent` existente con `reason`).

## Success Criteria

- [ ] Baja de PPPoE → pide motivo → queda en el historial del contrato con "ver".
- [ ] Desasociar PPPoE → pide motivo → queda en el historial con "ver".
- [ ] El motivo se registra **una sola vez** (en el use case), sin doble evento ni race.
- [ ] El alta (asociar/crear) registra evento `activated` (historial completo).
- [ ] `npm test` (BE) + vitest (FE) verdes; tsc/typecheck limpios; review GO.
