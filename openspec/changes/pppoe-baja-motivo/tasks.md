# Tasks: PPPoE baja/desasociar con motivo + historial

> TDD estricto. BE worktree `feat/pppoe-baja-motivo` (motivo-be). FE worktree (motivo-fe).

## BE — registrar evento en el use case
- [ ] **(test primero)** `EnsureInternetContractService` con `ContractServiceEventRepository`: inactivar → evento `deactivated` con reason+actor; activar/crear → `activated`; no-op → sin evento; best-effort (eventRepo.record throw → no rompe).
- [ ] `EnsureInternetContractService.ts`: inyectar cseRepo (opcional) + `opts?:{reason?,actorId?,actorName?}` + record best-effort en cada transición.
- [ ] **(test primero)** `DeactivatePppoeService` con `{reason,actor}` → ensureInternet(false,opts) → evento con motivo.
- [ ] `DeactivatePppoeService.ts`: `execute(id, opts?)`.
- [ ] **(test primero)** `DeassociatePppoeFromContract` con `{reason,actor}` → ensureInternet(false,opts) → evento con motivo.
- [ ] `DeassociatePppoeFromContract.ts`: `execute(pppoeId, contractId, opts?)`.
- [ ] `AssociatePppoeToContract` + `CreatePppoeService`: pasar actor a ensureInternet(true) (evento `activated`).
- [ ] `pppoe.routes.ts`: `DELETE /pppoe/:id` + `DELETE /contracts/:cid/pppoe/:pppoeId` parsean `reason` (zod) del body + actor de req.user.
- [ ] `app.ts`: wiring cseRepo en `EnsureInternetContractService` (+ composition test).

## FE — modal de motivo en baja + desasociar
- [ ] **(test primero)** baja abre `ServiceRemovalReasonModal` → confirma → `deactivate` con reason; desasociar abre el MODAL (no el confirm plano) → `deassociate` con reason.
- [ ] `pppoe.api.ts`: `deactivate(id, reason?)` + `deassociate(contractId, pppoeId, reason?)` → `{ reason }` en el body del DELETE.
- [ ] `usePppoe.ts`: `useDeactivate`/`useDeassociate` pasan reason.
- [ ] `InternetPanel.tsx`: `handleBaja(reason)` → deactivate({id,reason}), SACAR el PATCH redundante; `handleDeassociate(reason)` con `ServiceRemovalReasonModal` (reemplaza el confirm plano).

## Verificación
- [ ] BE: `npm test` verde + tsc limpio. DIP. Composition test.
- [ ] FE: vitest verde + typecheck limpio.
- [ ] Review adversarial (obligatorio): foco en no-doble-evento + best-effort + el motivo realmente persiste.

## Post-deploy (en vivo, .37 arriba)
- [ ] Playwright: baja un PPPoE con motivo → aparece en el historial del contrato con "ver" → abre `ReasonViewModal` con el texto. Idem desasociar.

## Salida
- [ ] Baja y desasociar de PPPoE piden motivo y lo dejan en el historial con "ver", igual que TV.
