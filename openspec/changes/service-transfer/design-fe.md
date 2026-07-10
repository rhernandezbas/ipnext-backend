# Design FE — service-transfer (Wave 4, repo ipnext-frontend)

Anclas de la exploración 2026-07-10. Greenfield: no existe transfer hoy; se clonan patrones.

## Entrada de la acción

Los 3 paneles viven en `src/pages/customers/tabs/contracts/ContractCard.tsx:51`:
- TV → `GigaredPanel` (`:206`, gate `tv.read`)
- Internet → `InternetPanel` (`:215`, gate `pppoe.manage||pppoe.cut`)
- Equipos → `ServiceInventorySection` (`:185`, inline)

El botón "Transferir a otro cliente" va DENTRO de cada panel (junto a las acciones vecinas),
gateado con `<Can permission="tv.transfer|pppoe.transfer|inventory.transfer">` (`Can.tsx:34`).

## Modal de transferencia (compartido, 3 variantes)

Componer: `CustomerPicker` (typeahead, `scheduling/SchedulingTasksPage/components/CustomerPicker.tsx:18`
— copiar a `components/molecules/` compartido) + `<select>` de contratos del destino
(`useClientContracts(targetClientId)`, key `['client-contracts', id]`) + confirmación de-quién-a-quién.
- PPPoE: radio modo `recreate` (default) / `as-is`; si as-is → textarea motivo OBLIGATORIO
  (patrón `ServiceRemovalReasonModal`, tone primary). Recreate: prefill de los datos del PPPoE viejo.
- Equipos: checkboxes de ítems (default todos marcados).
- Dos pasos + resultado visible sin auto-cerrar: patrón `MoveNasModal`
  (`PppoeManagementTab.tsx:591`). Parciales 207: mostrar el detalle (severed/localSource/localTarget
  o "viejo pendiente de borrar") — NUNCA "éxito" plano en un 207.

## API + hooks

- Métodos nuevos: `gigaredApi.transferTv(customerId, body)`, `pppoeApi.transfer(id, body)`,
  `serviceInventory.transfer(contractId, body)`.
- Hooks `useTransferTv/useTransferPppoe/useTransferEquipment` (patrón `useMovePppoe`,
  `usePppoe.ts:131`). Invalidación DE AMBOS CLIENTES: `['client-contracts', from]`, `[..., to]`,
  `['contract-pppoe', from/to]`, TV: `accountKey(from)`, `accountKey(to)`, `SUMMARY_KEY`,
  `SERVICE_HISTORY_ROOT` (set completo en `useGigared.ts:157-165`).
- Errores tipados: helpers `errorCode/errorDetail` (`GigaredPanel.tsx:70-85`); 409
  `TV_ALREADY_LINKED`/`PPPOE_CONTRACT_HAS_SERVICE` con mensajes claros.

## Historial

- Rama nueva en `PlanChangeInfo` (`InternetActivationHistoryModal.tsx:117-167`) para
  `changeKind === 'transfer-out'` → "⇄ Transferido a {newValue}" y `'transfer-in'` →
  "⇄ Recibido por transferencia de {oldValue}"; si `notes` marca "tal cual" → badge ámbar
  "pendiente de regularizar". NO se toca `ServiceEventType` (seguimos con eventType `modified`
  + changeKind → cero cambios en los 3 mapas `Record<ServiceEventType,...>`).
- El historial TV es un modal APARTE (`ActivationHistoryModal`, `GigaredPanel.tsx:374`) — si el
  evento TV de transfer entra por ContractServiceEvent aparece en el historial de Internet/servicios;
  verificar en la wave si amerita label también en el modal TV.

## ui-ux-pro-max

Correr `python .claude/skills/ui-ux-pro-max/scripts/search.py "transfer service modal confirmation" --design-system`
ANTES de escribir UI. CSS Modules + tokens `var(--color-*)`; contraste ≥4.5:1, touch ≥44px,
focus visible, transiciones 150-300ms, loading/empty states.
