# Design — internet-history-plan-direction

## Decisión clave: derivar la dirección, NO persistirla
La dirección (`upgrade`/`downgrade`) se calcula al LEER comparando `downloadKbps(newPlan)` vs `downloadKbps(oldPlan)` contra el catálogo de planes. Se persisten SOLO los códigos (`oldPlan`/`newPlan`).

**Por qué:** el `downloadKbps` de un plan es editable (un plan comercial puede recategorizarse o cambiar su velocidad). Persistir la dirección la congelaría al valor del momento del cambio y driftearía si el catálogo cambia. Derivar mantiene una sola fuente de verdad (el catálogo) y hace el dato auto-consistente. Costo: 1 `PlanRepository.list()` por request de historial (catálogo chico, cacheable a futuro si hace falta).

## Reglas de derivación (`deriveDirection`)
`direction = null` cuando cualquiera de estas se cumple (en orden):
1. `eventType !== 'modified'` (no es un cambio de plan).
2. Falta `oldPlan` o `newPlan`.
3. `isEnforcementPlan(oldPlan) || isEnforcementPlan(newPlan)` — `IP-REDUCCION`/`IP-BAJA` son grupos de sistema (corte/reducción), no cambios comerciales. Se reusa el helper de dominio `isEnforcementPlan` (`domain/entities/plan.ts:27`) — misma dimensión que el orchestrator reserva.
4. Algún código no está en el catálogo (`kbpsByCode.get(code) === undefined`).
5. `newKbps === oldKbps` (cambio lateral).
Si no: `newKbps > oldKbps → 'upgrade'`, `newKbps < oldKbps → 'downgrade'`.

## Filtros: tópico (push-down) vs dirección (in-memory)
- **`eventType` (tópico)**: se empuja al port (`ListContractServiceEventsFilter.eventType` → `where.eventType` en Prisma; filtro equivalente en el InMemory). Es una columna indexable → filtrado en la DB.
- **`direction`**: NO se puede empujar (es derivado, no una columna). Se aplica in-memory en el use case DESPUÉS de mapear a DTO. Es INDEPENDIENTE de `eventType`: un `direction=upgrade` sin `eventType` igual excluye los no-`modified` porque su `direction` es `null`. No se fuerza `eventType='modified'` implícitamente — la semántica queda en la derivación.

## DIP / capas
- `PlanRepository` es un port de dominio ya existente; `ListInternetServiceHistory` lo recibe por constructor (3er arg, requerido). El use case NO importa Prisma. El wiring inyecta `PrismaPlanRepository` (`app.ts`).
- `isEnforcementPlan` es conocimiento puro de dominio (no infra).
- El DTO nunca expone entidades Prisma; el mapeo (incl. derivación) ocurre en el use case.

## Migración
`prisma migrate diff --from-schema <HEAD schema> --to-schema <schema actual> --script` (Prisma 7 renombró `--from-schema-datamodel`→`--from-schema`). Output verificado = exactamente:
```sql
ALTER TABLE "contract_service_events" ADD COLUMN "newPlan" TEXT, ADD COLUMN "oldPlan" TEXT;
```
2 columnas nullable = aditivo/seguro. Guardada en `prisma/migrations/20260828000000_contract_service_event_plan_change/migration.sql` (timestamp posterior a la última, `20260827000000`).

## Backfill (fuera de la migración)
Script `scripts/backfill-contract-service-event-plans.ts`, idempotente y re-ejecutable:
- Toca SOLO `eventType='modified'` con `newPlan IS NULL` (guardia de idempotencia: una fila ya backfilleada tiene `newPlan` seteado y se saltea).
- Parsea `notes` por el separador `" → "` (U+2192); `'—'` (U+2014) → `null`; si no parte en exactamente 2, se saltea y reporta como malformado.
- Dry-run por defecto; `CONFIRM=YES` para escribir (convención de `scripts/`).
- **Nota de idempotencia**: el plan original pedía filtrar por `oldPlan IS NULL`, pero un `modified` con profile original null tiene `oldPlan` legítimamente null → se re-procesaría en cada corrida. Se usa `newPlan IS NULL` como guardia (todo cambio real tiene destino) → verdaderamente idempotente.

## Gotcha: el cliente Prisma no se regenera en el worktree
El adapter usa `(prisma as any).contractServiceEvent` (igual que el código #110 existente) porque el `node_modules` del worktree comparte el client sin regenerar. Las columnas nuevas van por ese `as any`; el Dockerfile regenera en prod. Por eso el `tsc --noEmit` NO valida los nombres de columna nuevos (esperado y consistente con el patrón previo).
