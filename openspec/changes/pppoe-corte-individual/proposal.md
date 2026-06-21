# Proposal: Corte individual del servicio de internet (Reducir/Cortar/Restaurar) con motivo + historial

## Intent

Exponer el **corte INDIVIDUAL** de un PPPoE desde la ficha del contrato (panel de internet): **Reducir** (velocidad reducida/captive), **Cortar** (bloqueo total) y **Restaurar** — cada uno **con motivo** que queda en el **historial del contrato con "ver"**, igual que la baja/desasociar.

## Why

- El BE YA tiene el motor de enforcement individual (`EnforcePppoeService`, acciones `reduce`/`block`/`restore`, `enforcedState`, patrón red-primero, ruteo per-NAS). Solo está expuesto en el **corte masivo** (página de Cortes), NO en la ficha individual del cliente.
- El operador necesita cortar/reducir/restaurar UN cliente desde su ficha (ej. por deuda puntual), con trazabilidad del por qué.

## Scope

### In Scope

**BE — motivo + evento de historial en el enforce (el enforce YA existe):**
- `ServiceEventType` (port): agregar `'reduced' | 'blocked' | 'restored'` (es un String libre en la DB → **sin migración**).
- Nuevo helper `RecordPppoeEnforceEvent` (best-effort): resuelve catálogo `getByName('INTERNET')` → `eventRepo.record({ eventType, reason, actor })`. NO toca el `status` de la línea (el servicio sigue existiendo, solo throttled). Espeja el seam de `EnsureInternetContractService` pero solo registra evento.
- `EnforcePppoeService`: 4º param opcional `recordEvent?` + `reason?/actorId?/actorName?` en el input; tras `setEnforcedState`, llama al helper best-effort (solo si `contractId != null`).
- `EnforcePppoeBodySchema` (dto): agregar `reason`.
- `ServiceEventDto.eventType` (dto): agregar los 3 valores.
- Ruta `POST /api/pppoe/:id/enforce`: parsear `reason` + `actorOf(req)`.
- `app.ts`: wire `RecordPppoeEnforceEvent`.

**FE — botones adaptativos + motivo (con `ui-ux-pro-max`):**
- `ServiceEvent.eventType` (type): +3 valores.
- `pppoe.api.ts`: `enforce(id, action, reason?)`.
- `usePppoe.ts`: `useEnforcePppoeForContract(contractId, clientId)` con `onSuccess` invalidando `['contract-pppoe', contractId]` (hoy `useEnforcePppoe` no invalida).
- `ServiceRemovalReasonModal`: props opcionales `title?` + `confirmLabel?` (back-compat — default "Dar de baja").
- `InternetPanel.tsx` (`ActivePppoeView`): sección `<Can pppoe.cut>` con botones **adaptativos al `enforcedState`**: active→[Reducir][Cortar], reduced→[Cortar][Restaurar], blocked→[Restaurar]. Cada uno abre el modal de motivo → `enforce(action, reason)`. Banner de error.
- `ServiceHistoryModal`: extender `EVENT_LABELS` (`reduced`:'Reducción', `blocked`:'Corte', `restored`:'Restauración') + `EventBadge`. El link "ver" ya es automático para cualquier evento con `reason`.

### Out of Scope
- El motor de enforce (ya existe). El corte masivo (página de Cortes, intacta). Migración (eventType es String libre).

## Capabilities

### Modified Capabilities
- PPPoE lifecycle: corte/reducción/restauración individual desde la ficha, con motivo + historial.

## Approach
1. **BE**: helper `RecordPppoeEnforceEvent` + threading reason/actor por enforce + ruta. TDD.
2. **FE**: api/hook + modal con title/confirmLabel + botones adaptativos + historial. TDD, ui-ux-pro-max.

## Affected Areas
| Área | Impacto |
|------|---------|
| `domain/ports/ContractServiceEventRepository.ts` | +3 eventType |
| `application/use-cases/RecordPppoeEnforceEvent.ts` | New — helper best-effort |
| `application/use-cases/EnforcePppoeService.ts` | reason/actor + record |
| `application/dto/{pppoe,contract-services}.dto.ts` | reason + eventType |
| `infrastructure/http/routes/pppoe.routes.ts` | reason + actorOf |
| `infrastructure/http/app.ts` | wiring (+ composition test) |
| **FE** `types/customer.ts` · `api/pppoe.api.ts` · `hooks/usePppoe.ts` | +eventType, enforce reason, hook |
| **FE** `components/molecules/ServiceRemovalReasonModal` | title/confirmLabel opcionales |
| **FE** `pages/.../InternetPanel.tsx` | botones adaptativos + modal + handler |
| **FE** `components/molecules/ServiceHistoryModal` | labels + badges nuevos |

## Risks
| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Registrar evento rompe el enforce | Baja | Best-effort (try/catch); el enforce nunca falla por el evento |
| Botones no adaptan bien al estado | Media | Mapa explícito enforcedState→acciones (active/reduced/blocked); tests FE |
| `EVENT_LABELS` Record cierra el union → type-error | — | Extender el union + el map juntos (lo fuerza tsc) |
| El enforce a un router caído | Baja | Patrón red-primero ya existente: 502, DB no cambia |

## Rollback
Aditivo + correcciones contenidas. Rollback = `git revert` (BE+FE). Sin migración.

## Dependencies
- `EnforcePppoeService` + enforce route + enforcedState (en prod). `EnsureInternet`/eventos (Change pppoe-baja-motivo, en prod). `ServiceRemovalReasonModal` + `ServiceHistoryModal` (en prod).

## Success Criteria
- [ ] En la ficha: Reducir/Cortar/Restaurar según el estado, con motivo, gated `pppoe.cut`.
- [ ] El enforce registra el evento (`reduced`/`blocked`/`restored`) con el motivo en el historial → "ver".
- [ ] El badge de estado (Reducido/Bloqueado) refleja el cambio tras la acción.
- [ ] BE + FE tests verdes; tsc/typecheck limpios; review GO.
