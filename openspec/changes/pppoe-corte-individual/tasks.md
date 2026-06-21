# Tasks: Corte individual con motivo + historial

> TDD estricto. BE worktree `feat/pppoe-corte-individual` (corte-be). FE (corte-fe). Skill ui-ux-pro-max en el FE.

## BE
- [ ] `domain/ports/ContractServiceEventRepository.ts`: `ServiceEventType` += `'reduced' | 'blocked' | 'restored'`.
- [ ] **(test primero)** `RecordPppoeEnforceEvent`: registra eventType correcto por acción (reduce→reduced, block→blocked, restore→restored) con reason+actor; sin catálogo → no-op; eventRepo lanza → no rompe (best-effort).
- [ ] `application/use-cases/RecordPppoeEnforceEvent.ts` (new).
- [ ] **(test primero)** `EnforcePppoeService` con `{reason,actor}` → evento con motivo; no-op idempotente (ya en estado destino) → SIN evento.
- [ ] `EnforcePppoeService.ts`: 4º param opcional `recordEvent?` + reason/actor en input + llamada best-effort (solo si contractId).
- [ ] `application/dto/pppoe.dto.ts`: `EnforcePppoeBodySchema` += `reason: z.string().nullish()`.
- [ ] `application/dto/contract-services.dto.ts`: `ServiceEventDto.eventType` += 3 valores.
- [ ] **(test primero)** ruta `POST /pppoe/:id/enforce {action, reason}` → evento registrado con el motivo (seam, espeja pppoe.baja-motivo.routes.test).
- [ ] `pppoe.routes.ts`: parsear reason + `actorOf(req)` → execute.
- [ ] `app.ts`: wire `RecordPppoeEnforceEvent` (catalogRepo + eventRepo) en `EnforcePppoeService` (+ composition test).

## FE (ui-ux-pro-max)
- [ ] `types/customer.ts`: `ServiceEvent.eventType` += 3 valores.
- [ ] `api/pppoe.api.ts`: `enforce(id, action, reason?)` → `{action, reason}` en el body.
- [ ] `hooks/usePppoe.ts`: `useEnforcePppoeForContract(contractId, clientId)` con `onSuccess` invalidando contract-pppoe + reason en las variables.
- [ ] `components/molecules/ServiceRemovalReasonModal`: props opcionales `title?` + `confirmLabel?` (default actual, back-compat).
- [ ] **(test primero)** `InternetPanel`: botones por enforcedState (active→Reducir+Cortar; reduced→Cortar+Restaurar; blocked→Restaurar); confirmar modal → enforce con {action, reason}; banner de error.
- [ ] `InternetPanel.tsx`: sección `<Can pppoe.cut>` con botones adaptativos + modal de motivo (title/confirmLabel por acción) + `handleEnforce` + `enforceError`.
- [ ] **(test primero)** `ServiceHistoryModal` renderiza label + "ver" para reduced/blocked/restored.
- [ ] `ServiceHistoryModal`: `EVENT_LABELS` + `EventBadge` para los 3 nuevos.

## Verificación
- [ ] BE: `npm test` verde + tsc limpio. DIP. Composition test.
- [ ] FE: vitest verde + typecheck limpio.
- [ ] Review adversarial (obligatorio): best-effort del record + botones adaptativos + no-op sin evento.

## Post-deploy (en vivo)
- [ ] Playwright: reducir/cortar/restaurar un PPPoE con motivo → badge cambia → historial con "ver". (Sin ensuciar un cliente real: usar uno de prueba o restaurar al final.)

## Salida
- [ ] Corte individual (reducir/cortar/restaurar) desde la ficha, con motivo + historial, como TV/baja.
