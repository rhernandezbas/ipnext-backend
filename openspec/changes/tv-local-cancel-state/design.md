# Design — tv-local-cancel-state

## Constraint (descubrimiento LIVE, divergencia #10)

El partner Gigared no tiene unlink. `PATCH internal_id ''` → 400 garantizado; mapeo
append-only; `renew` arrastra internal_ids; no hay DELETE. El estado "sin TV" NO puede
vivir en el partner → vive LOCAL en el mirror.

## Decision: flag local en el mirror + port dedicado

### Schema
`Client.tvCancelledAt DateTime?` — aditiva, nullable. El sync de GR nunca la escribe
(escribe sólo los campos que mapea desde Gestión Real). Es ortogonal a `status`.

### Port (DIP estricto)
`domain/ports/ClientTvCancellationRepository`:
```ts
markCancelled(clientId): Promise<void>   // tvCancelledAt = now (idempotente)
clearCancelled(clientId): Promise<void>  // tvCancelledAt = null (idempotente)
isCancelled(clientId): Promise<boolean>  // tvCancelledAt != null
```
Adapters: `PrismaClientTvCancellationRepository` (update/select sobre `Client`) +
`InMemoryClientTvCancellationRepository` (Set de ids) para tests.

Se inyecta como dep OPCIONAL (último parámetro) en los 4 use cases para no romper la
firma de los tests/callers existentes; el wiring real siempre la pasa.

### CancelTv — seam
Orden pinneado: customer 404 → contract 404 → **anti-coining (isCancelled → 404)** →
read account (404 → TvNotLinked) → DELETE packs → OTT off → reconcile local →
`if (renewAttempted && failed===0) renewCic` (best-effort, recicla cupo, SIN unlink) →
`if (failed===0) markCancelled → localCancelled=true`.

Puntos clave:
- El unlink (`setInternalId(newCic,'')`) se ELIMINA: era 400 seguro.
- `markCancelled` NO depende de que el renew haya salido bien: el estado honesto de la
  baja es "los packs se quitaron". El renew es sólo reciclaje de cupo.
- Anti-coining: el flag corta el retry ANTES de tocar el partner → no se acuñan CICs.

### Wire contract `CancelTvResult` (final)
```
removed: string[]
failed: { id, detail }[]
unremovable: { id, detail }[]
ottDisabled: boolean
local: 'synced' | 'failed'
renew: { oldCic, newCic } | null
localCancelled: boolean        // <- reemplaza `unlinked`
renewAttempted: boolean
```
Router 207 si: `failed.length>0 || local==='failed' || !ottDisabled ||
(renewAttempted && renew===null)`. El unlink ya no factoriza.

### GetGigaredCustomerAccount
`isCancelled` primero → `{ linked:false, account:null }` sin llamar al partner. Mantiene
limpio el panel aunque el internal_id siga resolviendo en Gigared.

### Link / Register
`clearCancelled` best-effort tras el bind exitoso → el cliente recupera TV; el panel
vuelve a mostrar la cuenta.

## Alternatives considered
- **Persistir CIC local + reintentar unlink**: descartado — no existe unlink en el
  partner; persistir el CIC no resuelve la baja (sólo evitaría acuñar más CICs).
- **Usar `Client.status`**: descartado — `status` lo maneja el sync de GR y mezcla
  semánticas (active/late/blocked/baja); la baja de TV es ortogonal al estado del cliente.

## Migration
`20260712000000_client_tv_cancelled_at`:
`ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "tvCancelledAt" TIMESTAMP(3);`
Aditiva, idempotente, sin BEGIN/COMMIT (Prisma envuelve cada migración en su propia tx).
