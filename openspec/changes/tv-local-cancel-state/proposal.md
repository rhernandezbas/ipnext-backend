# tv-local-cancel-state — Baja TV LOCAL honesta (#72 rework)

## Why

El diseño previo del #64/#67 asumía que la baja de TV podía "desvincular" la cuenta en
el partner Gigared llamando `setInternalId(newCic, '')` tras renovar el CIC. Una
investigación LIVE (2026-06-12, divergencia #10 de Gigared) demostró que esa premisa es
FALSA:

- `PATCH /accounts/{cic}/internal_id { internal_id: '' }` → **HTTP 400 SIEMPRE**
  (`invalid-internal-id`, "Debe tener entre 1 y 50 caracteres"). El unlink del #64
  **nunca funcionó**.
- El mapeo `internal_id ↔ CIC` es **N:1 append-only**: PATCH agrega un mapeo, no
  reemplaza ni quita. `DELETE` → 405/404. `renew` arrastra TODOS los internal_ids al CIC
  nuevo.
- Consecuencia: `getAccountByInternalId(customerId)` sigue resolviendo 200 después de la
  baja → el panel mostraba al cliente VINCULADO. La baja nunca quedaba reflejada.

El partner NO ofrece ninguna primitiva de desvinculación. La única semántica honesta es
una **baja LOCAL**.

## What changes

1. **`Client.tvCancelledAt TIMESTAMP NULL`** — columna aditiva en el mirror. El sync de
   Gestión Real NO la toca. Es la única señal de "este cliente quedó sin TV".
2. **`CancelTv`**: setea `tvCancelledAt` cuando el desmontaje fue completo
   (`failed.length === 0`). Quita el paso unlink muerto (`setInternalId(newCic,'')`). El
   `renewCic` SIGUE intentándose (best-effort) para reciclar el cupo del pack base
   irremovible. El campo `unlinked` del result se reemplaza por `localCancelled`.
3. **Anti-acuñado de CICs**: si `tvCancelledAt` ya está seteado al entrar a `CancelTv`, se
   lanza `TvNotLinkedError` (404) ANTES de tocar el partner → un retry jamás re-renueva ni
   acuña un CIC nuevo. El edge del #67 muere.
4. **`GetGigaredCustomerAccount`**: si `tvCancelledAt` está seteado → `{ linked: false }`
   sin llamar al partner, aunque la cuenta siga resolviendo por internal_id. Panel limpio.
5. **`LinkCustomerToCic` + `RegisterGigaredAccount`** exitosos → limpian el flag
   (`clearCancelled`, best-effort): el cliente vuelve a tener TV.
6. **FE**: el modal de baja quita el copy de "desvinculación"; el renew se informa como
   reciclaje de cupo; aparece la línea "Cuenta liberada — el cliente queda sin TV"; el
   panel post-baja muestra no-vinculado.

## Impact

- Affected specs: `gigared-tv-cancel` (baja TV), `gigared-customer-account` (panel).
- Wire contract: `CancelTvResult.unlinked` → `CancelTvResult.localCancelled` (FE y BE
  alineados campo por campo).
- Migración aditiva idempotente, sin BEGIN/COMMIT. Reversible (drop column).
- El reconcile/credenciales del #65/#67 quedan intactos.
