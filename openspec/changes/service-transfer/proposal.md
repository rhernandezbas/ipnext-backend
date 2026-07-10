# Proposal — service-transfer (EPIC Titularidad & bajas, F1)

## Intent

Transferir servicios entre clientes SIN baja y SIN perder identidad del servicio, con registro
SIEMPRE. Caso disparador: cambio de titularidad Martino Agustina → Martino Marcelo Julián
(reporte de Carolina, 2026-07-08): la TV quedaba atada al titular viejo, el link al nuevo daba
409 y el único workaround era `CancelTv` (destruye login/cuenta del CUA).

F1 del EPIC "Titularidad & bajas" (BACKLOG.md). El detector automático + page "Acciones" = F2
(fuera de alcance acá). TV auto-transfer = F3.

## What

Acción "Transferir a otro cliente" por tipo de servicio, BE + FE:

1. **TV (Gigared/CIC)** — `TransferTvToCustomer`: alias del `internal_id` al cliente destino
   (el CUA NO pisa: aliasa, verificado F0 2026-07-10) + severing local del origen
   (`tvCancelledAt`, mecanismo #72) + reconcile de slots TV locales + eventos en ambos
   historiales. **Jamás `CancelTv` sobre el origen** (mataría la cuenta que usa el destino).
2. **PPPoE** — `TransferPppoe` con dos modos:
   - `recreate` (default recomendado): crear el PPPoE nuevo en el contrato destino PRIMERO,
     borrar el viejo DESPUÉS (si el create falla, el viejo queda intacto).
   - `as-is` (fallback, ej. sin acceso a la antena): reasigna el `contractId` sin tocar RADIUS,
     con **motivo OBLIGATORIO** y marca distintiva en el historial ("pendiente de regularizar").
3. **Equipos** — `TransferContractEquipment`: mueve ítems seleccionados (`ContractInstalledItem`)
   al contrato destino y, si el ítem tiene `assetId`, emite `InventoryMovement TRANSFER` entre
   las CLIENTE-locations (ledger EPIC #38).
4. **Auditoría (transversal, innegociable)**: TODA transferencia graba eventos en el historial
   de AMBOS clientes — quién/cuándo/de→a/CÓMO (recreado|tal cual)/motivo — vía
   `ContractServiceEvent` con `changeKind: 'transfer-out' | 'transfer-in'`.
5. **FE**: botón "Transferir a otro cliente" en cada sección de servicio de la ficha → modal
   (cliente destino + contrato + modo/motivo + selección de ítems) con confirmación explícita
   de-quién-a-quién; labels de transfer en el historial.

## Decisions (tomadas, el usuario delegó salvo negocio)

- **Permiso granular NUEVO por módulo**: acción `transfer` en `KNOWN_ACTIONS` → guards
  `tv:transfer`, `pppoe:transfer`, `inventory:transfer` (doble capa BE+FE, regla del workflow).
- **Equipos: selección ítem-por-ítem** (checkboxes, default todos marcados).
- **Dirección de eventos**: `transfer-out` en el contrato origen, `transfer-in` en el destino;
  `oldValue`/`newValue` = nombre del cliente origen/destino (snapshot legible).
- **PPPoE recreate compone use cases existentes** (`CreatePppoeService` → `TerminatePppoeService`),
  no reimplementa provisioning.

## Out of scope

- Detector de titularidad + pairing + page "Acciones" (F2).
- TV auto-transfer (F3).
- Renombrar el CRM del partner (sin API; el nombre de la cuenta CUA queda el del titular original).
- Backfill del caso Martino (cerrado manualmente en F0; sus eventos de historial no se sintetizan).

## Risks / flags

- **Toca `app.ts`** (wiring de 3 use cases + guards) → known_debt `god-object-app` (config.yaml).
- **El CUA miente**: `setInternalId` devuelve 200 sin efecto visible en el payload → el use case
  VERIFICA el alias re-leyendo por el internal_id destino antes de tocar estado local.
- **Slot TV origen**: el reconcile account-driven NO sirve para el origen (su internal_id sigue
  resolviendo por el alias) → inactivación DIRECTA del slot.
- Handlers nuevos con `next(err)` SIEMPRE (lección 504, sweep 2026-07-03).
