# Design — service-history-ledger (#110)

## Decisión 1 — Ledger genérico append-only nuevo, NO ampliar ContractService
`ContractService` tiene `@@unique([contractId, serviceCatalogId])` (`schema.prisma:593`): UNA fila por par. Es el read-model del estado ACTUAL (status + deactivatedAt) — perfecto para "¿qué tiene contratado hoy?", inútil para "¿cómo cambió en el tiempo?". Reactivar pisa `status`/`deactivatedAt` y borra la historia.

Solución: tabla **append-only** separada `contract_service_events` (modelo `ContractServiceEvent`), espejo conceptual de `tv_activation_events`:

```prisma
// Append-only log of every status change of a NON-TV contract service.
// actorId is a SOFT FK (SetNull on RbacUser delete) so history survives user deletion.
// contractId cascades on Contract delete. GR sync NEVER writes this table.
model ContractServiceEvent {
  id               String   @id @default(uuid())
  contractId       String
  serviceCatalogId String
  // 'activated' = alta inicial, 'deactivated' = baja, 'reactivated' = re-alta tras baja.
  eventType        String
  actorId          String?
  actor            RbacUser? @relation("ContractServiceEventActor", fields: [actorId], references: [id], onDelete: SetNull)
  actorName        String   @default("")  // snapshot, legible tras borrado del user
  notes            String?
  createdAt        DateTime @default(now())

  contract Contract @relation(fields: [contractId], references: [id], onDelete: Cascade)

  @@index([contractId, createdAt])
  @@map("contract_service_events")
}
```

Razón de NO meter `serviceCatalog` como relación dura: el evento referencia el catálogo por id (suficiente para agrupar por servicio); evitamos un `onDelete: Restrict` que ate la borrabilidad del catálogo a la existencia de eventos históricos. `actorName` con `@default("")` para parear el patrón de `TvActivationEvent.actorName` (snapshot legible).

`RbacUser` gana la relación inversa `contractServiceEvents ContractServiceEvent[] @relation("ContractServiceEventActor")` y `Contract` gana `contractServiceEvents ContractServiceEvent[]`.

## Decisión 2 — CRUZAR fuentes, NO unificar/duplicar TV (la decisión clave)
**Pregunta:** ¿registramos TODO (incluido TV) en el ledger genérico, o cruzamos dos tablas en lectura?

**Decisión: CRUZAR en lectura. NO duplicar eventos TV en el genérico.**

Justificación:
1. TV YA tiene su ledger append-only (`tv_activation_events`) cableado y testeado en PROD: `RegisterGigaredAccount.ts:178-194` registra `alta`/`reactivacion`, `CancelTvJobRunner.ts:57-71` registra `baja`. Todos best-effort. Duplicar esos eventos en `contract_service_events` obligaría a tocar esos call-sites críticos (riesgo de doble registro, drift entre tablas) sin ganancia.
2. TV tiene detalle propio rico (CIC, seq, internalId) que el genérico no modela. Forzar TV al genérico perdería ese detalle o ensuciaría el modelo genérico con columnas TV.
3. El genérico cubre EXACTAMENTE el gap: internet/voz/cámaras/otros, que hoy no tienen ledger.

**Discriminador TV vs no-TV** (verificado): un `ContractService` es TV sii `tvLogin !== null` (es `null` para no-TV; lo setea `RegisterGigaredAccount`/`reconcileTvContractService`, lo limpia la baja). El use-case de historial usa ese flag por fila para elegir la fuente de eventos.

**Forma común de evento** (`ServiceEventDto`): ambas fuentes se mapean a `{ id, eventType, occurredAt, actorName, cic? }`:
- `contract_service_events`: `eventType` ya es `activated|deactivated|reactivated`; `cic` ausente.
- `tv_activation_events`: se traduce `alta→activated`, `baja→deactivated`, `reactivacion→reactivated`; `cic` se conserva; `occurredAt = createdAt`; `actorName` directo.

El cruce TV se filtra por `contractId` (la columna existe en `tv_activation_events`, `schema.prisma:2406`). Es a nivel contrato, no por `serviceCatalogId`, pero como un contrato tiene a lo sumo UN servicio TV, el filtro por contrato basta para asociarlo a la fila TV.

## Decisión 3 — Use-case de historial: componer, no romper #73
`ListContractServiceHistory` se reescribe para devolver `ContractServiceHistoryItemDto[]` donde cada item conserva sus campos #73 + un nuevo `events: ServiceEventDto[]`. Pasos:
1. `csRepo.listByContract(contractId)` → filas de servicio (sin cambio).
2. `cseRepo.listByContract(contractId)` → eventos genéricos del contrato (agrupables por `serviceCatalogId`).
3. `tvEventRepo.list({ ... })` o un método nuevo por contrato → eventos TV del contrato.
4. Por cada fila: si `tvLogin !== null` adjuntar los eventos TV (mapeados); si no, los genéricos de su `serviceCatalogId`. Ordenar `events` por `occurredAt` asc.
5. Degradación elegante: si un servicio no-TV no tiene eventos (legacy pre-migración), `events` se sintetiza con un único `activated` derivado de `createdAt` (y `deactivated` derivado de `deactivatedAt` si está inactivo). Esto garantiza que el modal SIEMPRE muestre al menos la alta, igual que hoy.

El use-case depende de TRES ports (todos interfaces de `domain/ports/`): `ContractServiceRepository`, `ContractServiceEventRepository`, `TvActivationEventRepository`. DIP intacto.

### Por qué TvActivationEventRepository necesita un listByContract
Hoy el port expone `listByClient` y `list({clientId,actorId,from,to})` — NO filtra por `contractId`. Agrego `listByContract(contractId)` al port + ambos adapters (Prisma: `where:{contractId}`; InMemory: filtra el store). Aditivo, no rompe los call-sites existentes.

## Decisión 4 — Wiring de registro (best-effort, patrón #10 / TV)
Los use-cases NO-TV se cablean para registrar eventos. El status hoy se deriva en el ADAPTER (`PrismaContractServiceRepository.update` lee el row actual para decidir la transición). Para que el use-case sepa si hubo transición SIN duplicar esa lógica:

- **`AddContractService`**: tras `csRepo.add(...)` exitoso → `record({ eventType:'activated', ... })`. Siempre hay transición (alta nueva).
- **`UpdateContractService`**: cuando `data.status` está presente, leer el estado previo (`csRepo.getById(id)`) ANTES del update; comparar con el nuevo status; si `active→inactive` → `deactivated`, si `inactive→active` → `reactivated`; si no cambió, NO registrar. El use-case recibe el `actor` (actorId/actorName) por parámetro desde la ruta (req.user).
- **`RemoveContractService`**: leer la fila (`getById`) antes de borrar; si existía y estaba `active`, registrar `deactivated` (baja por eliminación). Idempotencia preservada (id inexistente = no-op, sin evento).

Los use-cases reciben `ContractServiceEventRepository` como dep OPCIONAL (constructor param opcional, igual que `eventRepo?` en `CancelTvJobRunner`) para no romper los tests #73 existentes que construyen los use-cases sin él. Cada `record` va en try/catch con `console.warn` (patrón exacto de `RegisterGigaredAccount.ts:178-194`).

**Actor en las rutas**: la ruta hoy NO pasa `req.user` a estos use-cases. Hay que threadear `actorId`/`actorName` desde el middleware de auth (igual que la ruta de cancel TV thread-ea el actor al runner). Verificar la forma de `req.user` en `authMiddleware` y pasar `{ actorId, actorName }` a `updateSvc.execute(...)` / `removeSvc.execute(...)` / `addSvc.execute(...)`.

## Decisión 5 — Migración aditiva (CREATE TABLE)
Tabla nueva → migración aditiva pura. Última migración existente: `20260721000000_add_tv_activation_event`. La nueva: **`20260722000000_add_contract_service_event`**.

Generar el SQL con `prisma migrate diff` (NUNCA `migrate dev` contra prod):
```bash
git show HEAD:prisma/schema.prisma > /tmp/schema-head.prisma
npx prisma migrate diff \
  --from-schema-datamodel /tmp/schema-head.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/20260722000000_add_contract_service_event/migration.sql
```
SQL esperado (CREATE TABLE + 1 índice + 2 FKs, SIN BEGIN/COMMIT — Prisma envuelve cada migración en su transacción):
```sql
CREATE TABLE "contract_service_events" (
    "id"               TEXT NOT NULL,
    "contractId"       TEXT NOT NULL,
    "serviceCatalogId" TEXT NOT NULL,
    "eventType"        TEXT NOT NULL,
    "actorId"          TEXT,
    "actorName"        TEXT NOT NULL DEFAULT '',
    "notes"            TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "contract_service_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "contract_service_events_contractId_createdAt_idx"
    ON "contract_service_events"("contractId", "createdAt");
ALTER TABLE "contract_service_events" ADD CONSTRAINT "contract_service_events_contractId_fkey"
    FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contract_service_events" ADD CONSTRAINT "contract_service_events_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

## Decisión 6 — Wire contract BE↔FE (campo por campo, sin drift)

### ServiceEventDto (nuevo, en contract-services.dto.ts)
| Campo | Tipo | Notas |
|-------|------|-------|
| `id` | `string` | id del evento |
| `eventType` | `'activated' \| 'deactivated' \| 'reactivated'` | normalizado en ambas fuentes |
| `occurredAt` | `string` (ISO 8601) | = createdAt del evento |
| `actorName` | `string` | operador (snapshot); `''` si desconocido |
| `cic` | `string \| null` | SOLO presente/no-null para eventos TV; `null` en no-TV |

### ContractServiceHistoryItemDto (#73, EXTENDIDO — no se quita ningún campo)
| Campo | Tipo | Cambio |
|-------|------|--------|
| `id`,`contractId`,`serviceCatalogId`,`name`,`label`,`status`,`notes`,`tvLogin`,`createdAt`,`deactivatedAt` | igual que #73 | sin cambio (no rompe FE) |
| `events` | `ServiceEventDto[]` | **NUEVO** — orden cronológico ASC |

`tvPassword` NUNCA aparece (ni a nivel item ni evento). Mapper `toContractServiceHistoryItemDto(view, events)` extendido.

### FE — src/types/customer.ts
`ServiceHistoryEntry` gana `events: ServiceEvent[]` con `ServiceEvent = { id; eventType: 'activated'|'deactivated'|'reactivated'; occurredAt: string; actorName: string; cic: string | null }`. El hook `useContractServiceHistory` no cambia de firma. `ServiceHistoryModal` agrega, en cada fila, la secuencia de eventos (sub-tabla o lista expandible, estilo `ActivationHistoryModal`: Fecha · Tipo · Operador · CIC).

## Matriz scenarios → tests (STRICT TDD: red → green → refactor)

| # | Requirement / Scenario | Test BE (use-case, InMemory) | Test BE (ruta, supertest) | Nota FE (Vitest) |
|---|------------------------|------------------------------|---------------------------|------------------|
| R1.1 | Servicio no-TV con alta→baja→reactivación devuelve 3 eventos en orden | `ListContractServiceHistory.test.ts`: seed 1 servicio + 3 eventos en CSE repo → item.events = [activated, deactivated, reactivated] asc | — | — |
| R1.2 | Servicio TV cruza con tv_activation_events (no con el genérico) | mismo test: servicio con `tvLogin` set + eventos en tvEventRepo (alta/baja) → item.events mapeados [activated, deactivated] con `cic` | — | modal muestra CIC en eventos TV |
| R1.3 | Servicio sin eventos (legacy) → events sintetizados de createdAt/deactivatedAt | seed servicio inactive sin eventos → events = [activated(createdAt), deactivated(deactivatedAt)] | — | — |
| R1.4 | tvPassword AUSENTE en toda la respuesta | assert ningún item ni evento tiene `tvPassword` | `expect(JSON.stringify(body)).not.toContain('tvPassword')` | — |
| R2.1 | AddContractService registra `activated` best-effort | `AddContractService.test.ts`: tras add, cseRepo tiene 1 evento `activated` | POST /services → 201 + evento registrado | — |
| R2.2 | UpdateContractService active→inactive registra `deactivated`; sin cambio de status NO registra | `UpdateContractService.test.ts`: transición → 1 evento; PATCH solo notes → 0 eventos | PATCH status → evento; PATCH notes → sin evento | — |
| R2.3 | UpdateContractService inactive→active registra `reactivated` | mismo test: transición inversa → `reactivated` | — | — |
| R2.4 | RemoveContractService de servicio activo registra `deactivated`; id inexistente no registra | `RemoveContractService.test.ts`: delete activo → 1 evento; delete inexistente → 0 | DELETE → 204 + evento | — |
| R2.5 | Fallo del eventRepo NO aborta la operación (best-effort) | inyectar repo que tira en `record` → la operación principal igual completa | — | — |
| R3.1 | GET service-history responde 200 con items+events para clients.read | — | supertest 200, shape con `events[]` | — |
| R3.2 | Permiso dos capas: 401 sin auth, 403 sin clients.read | — | 401 / 403 PERMISSION_DENIED | `<Can>` oculta el botón |
| R4.1 | Adapter parity: InMemory y Prisma CSE repo se comportan igual | test de paridad (record + listByContract newest/asc) | — | — |
| R5.1 (FE) | Modal renderiza la secuencia de eventos por servicio | — | — | `ServiceHistoryModal.test.tsx`: fila con events → sub-filas Fecha/Tipo/Operador; servicio sin events → solo estado actual |

Convención de orden: el repo `listByContract` de CSE devuelve newest-first (parea TV); el use-case ORDENA `events` por `occurredAt` ASC para la UI (secuencia temporal natural). Pinearlo en el test del use-case.
