# Design: Corte individual con motivo + historial

## Context

`EnforcePppoeService.execute({id, action})` ya cambia `enforcedState` (reduce/block/restore), patrón red-primero, idempotente. NO toma motivo ni registra evento. El corte NO cambia el `status` de la línea INTERNET (el servicio existe, solo throttled) → no sirve `EnsureInternetContractService` (ese flipea active/inactive). Hace falta un seam que SOLO registre el evento.

## Decisión 1 — Nuevo helper `RecordPppoeEnforceEvent` (no reusar EnsureInternet)

```ts
class RecordPppoeEnforceEvent {
  constructor(private catalogRepo: ServiceCatalogRepository, private eventRepo: ContractServiceEventRepository) {}
  // best-effort: NUNCA lanza
  async execute(contractId: string, action: 'reduce'|'block'|'restore', opts: {reason?, actorId?, actorName?}) {
    try {
      const catalog = await this.catalogRepo.getByName('INTERNET');
      if (!catalog) return;
      await this.eventRepo.record({ contractId, serviceCatalogId: catalog.id,
        eventType: ACTION_EVENT[action], reason: opts.reason ?? null,
        actorId: opts.actorId ?? null, actorName: opts.actorName ?? '' });
    } catch (err) { console.warn('[RecordPppoeEnforceEvent] best-effort:', err); }
  }
}
const ACTION_EVENT = { reduce:'reduced', block:'blocked', restore:'restored' } as const;
```
**Por qué no `EnsureInternet`**: ese cambia el status de la línea (active/inactive). El corte NO inactiva la línea — el servicio sigue contratado, solo limitado. Este helper solo registra el evento.

## Decisión 2 — eventType nuevos (sin migración)

`ServiceEventType` (port) y `ServiceEventDto.eventType` (dto) + `ServiceEvent.eventType` (FE type): agregar `'reduced' | 'blocked' | 'restored'`. La columna `eventType` es **String libre** en Prisma → sin migración. Labels: Reducción / Corte / Restauración.

## Decisión 3 — EnforcePppoeService threading

- `EnforcePppoeServiceInput`: + `reason?`, `actorId?`, `actorName?`.
- Constructor: 4º param `recordEvent?: RecordPppoeEnforceEvent` (opcional, back-compat con tests).
- Tras `setEnforcedState` OK: `if (s.contractId) await this.recordEvent?.execute(s.contractId, action, {reason, actorId, actorName})` (best-effort). El no-op idempotente (ya en el estado destino) NO registra evento (return temprano antes).
- Ruta `POST /pppoe/:id/enforce`: `EnforcePppoeBodySchema` + `reason` → `enforcePppoeService.execute({id, action, reason, ...actorOf(req)})`.

## Decisión 4 — FE botones adaptativos

`ActivePppoeView`, sección `<Can pppoe.cut>`:
```
enforcedState='active'  → [Reducir] [Cortar]
enforcedState='reduced' → [Cortar] [Restaurar]
enforcedState='blocked' → [Restaurar]
```
Cada botón setea `enforceModalOpen = action` → `ServiceRemovalReasonModal` con `title`/`confirmLabel` por acción (Reducir/Cortar/Restaurar) → `handleEnforce(action, reason)` → `enforceForContract.mutateAsync({id, action, reason})`. Banner `enforceError`.

- `ServiceRemovalReasonModal`: + props opcionales `title?`, `confirmLabel?` (default actual "Dar de baja: {serviceName}" / "Dar de baja").
- `useEnforcePppoeForContract(contractId, clientId)`: nuevo hook con `onSuccess` invalidando `['contract-pppoe', contractId]` (el `useEnforcePppoe` actual no invalida).
- `ServiceHistoryModal`: `EVENT_LABELS` + `EventBadge` para los 3 nuevos (badge: reduced→warning, blocked→danger, restored→success). El "ver" del reason ya es automático.

## Test Strategy (TDD)
- **BE**: `RecordPppoeEnforceEvent` (registra el evento correcto por acción, best-effort si eventRepo lanza). `EnforcePppoeService` con reason → evento con motivo; no-op idempotente → sin evento. Seam ruta `POST /enforce {action, reason}` → evento registrado.
- **FE**: botones por enforcedState (active muestra Reducir+Cortar; blocked solo Restaurar); confirmar modal → enforce con {action, reason}; historial muestra label + "ver" para los nuevos eventos.

## Riesgo principal
El `Record<eventType,string>` del FE cierra el union → si agrego el evento sin el label, tsc falla (bueno: lo fuerza). Best-effort en el record para no romper el enforce.
