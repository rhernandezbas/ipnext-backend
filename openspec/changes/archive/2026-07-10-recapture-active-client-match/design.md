# Design: Recaptación — detector "posible cliente activo"

## Technical Approach
Clon estructural del patrón Tecnología (`34ae3c8c`): enrich en la capa use-case, batch por página, cero N+1. UNA query trae el set de clientes activos; un helper PURO (`matchActiveClient`, análogo a `deriveTechnology`) normaliza AMBOS lados y computa las 4 señales en memoria. Mismo helper + mismo set en list y detail → cero drift entre badge y drawer.

## Architecture Decisions

### Decisión 1 (CRÍTICA) — candidate set en memoria, NO Prisma OR-query
**Choice**: `customerRepo.listActiveContacts()` trae `{id,name,phone,email}` de todos los `status:'active'` (una query, index-assisted por `@@index([status])`), y se matchea EN MEMORIA con normalización de los DOS lados.
**Alternatives**: (A) Prisma `phone contains suffix`; (C) `$queryRaw` con `regexp_replace`.
**Rationale**: `contains` sólo normaliza el lado del LEAD — un `Client.phone` STORED como `"2324-555123"` o `"15 5551 2345"` (dato GR sucio) NUNCA matchea un sufijo de dígitos → FALSO NEGATIVO SILENCIOSO = llamada perdida = la feature falló. El recall es el criterio #1 (orden: recall > simplicidad > costo query). Opción B es la ÚNICA que normaliza el lado stored → recall máximo. Descarta A (falsos negativos) y C (cero precedente de `$queryRaw` en el repo, y sigue necesitando índice ausente). Costo: pull de ~10-14k filas angostas (4 columnas) por page-load — aceptable para tool interno; memoización = prematura (deferida).

### Decisión 2 — normalización de teléfono (helper puro, determinístico)
`normalizePhone(raw): string|null` → (1) null/vacío → null; (2) `raw.replace(/\D/g,'')`; (3) drop `54` inicial si len≥11; (4) drop `0` iniciales; (5) drop `9` inicial si len≥11; (6) drop `15` SÓLO si está al frente. NO remueve `15` embebido entre área y abonado (requiere tabla de códigos de área → fuera de scope, gap documentado). Comparación: `suffixMatch(a,b)` = `a.slice(-n)===b.slice(-n)` con `n=min(8,a.len,b.len)`, floor `MIN=6` (menos de 6 dígitos → null → no matchea; guarda contra basura/extensiones). Sufijo 8 (no 10): sobrevive a que un lado incluya/omita el área; falso positivo tolerable en badge informativo.

| Raw | normalizado | key (últimos 8) |
|-----|-------------|-----------------|
| `2324-421234` | `2324421234` | `24421234` |
| `02324 421234` | `2324421234` | `24421234` ✓ |
| `+54 9 2324 421234` | `2324421234` | `24421234` ✓ |
| `2324 15 421234` (15 embebido) | `232415421234` | `15421234` ✗ (gap) |
| `123` / `n/a` / null | — | null → no match |

### Decisión 3 — fail-OPEN
El enrich corre en fase 2, DESPUÉS de `repo.list()`/`getById()` (los leads ya están). `listActiveContacts()`+match (y la lectura del `motivoBaja` del contrato) van en `try/catch`: ante error → log + `possibleActiveMatchSignals:[]` / `possibleActiveMatch:{signals:[],matchedClients:[]}`. **Rationale**: el badge es secundario; un cliente/contrato corrupto JAMÁS debe voltear la tabla (función primaria). El helper es función TOTAL (nunca throw con basura).

### Decisión 4 — split de riqueza list/detail (sigue precedente `technologies`)
List DTO lleva sólo `string[]` de señales; detail lleva el match rico (`matchedClients: MatchedClientSummary[]`, ARRAY — spec autoritativo). Ninguno va en el base DTO (mutations no computan match → sin mentira empty-[]). Señal (c) reactivated y (a/b) contacto reusan EL MISMO set: `activeSet.has(lead.clientId)` = reactivado (sin query extra); (a/b) excluyen `lead.clientId`. Señal (d) → ver Decisión 6 (ya NO es CSV-only).

### Decisión 5 (NUEVA) — persistir `motivo_baja` de GR en `Contract.motivoBaja` (aditivo, GR-owned)
**Choice**: columna nueva `motivoBaja String?` (TEXT nullable) en el modelo mirror `Contract`, poblada por el delta sync desde el `motivo_baja` del feed `contratos` de GR. **Naming**: sigue el precedente del mirror field `vendedor` (nombre GR crudo, camelCase, columna sin `@map` — el schema usa columnas camelCase: `grContratoId`, `startDate`, `gpsLat`). Migración: `prisma/migrations/20260831000000_contract_motivo_baja/migration.sql` (timestamp DESPUÉS del último, `20260830000000_pppoe_change_audit`) = `ALTER TABLE "Contract" ADD COLUMN "motivoBaja" TEXT;`. Generada con `prisma migrate diff` (Prisma 7) y desplegada con `prisma migrate deploy` (aditiva = safe).
**Sync write point (grounded)**: el write es aditivo en tres puntos y el use case NO se toca:
- `domain/entities/gestionReal.ts` → `GrContract` gana `motivoBaja: string | null` (junto a `vendedor`, L118-120).
- `infrastructure/adapters/gestion-real/GestionRealClient.ts` → `parseContractsDeltaResponse` (L263-277) y `parseContractsResponse` (L236-250) mapean `motivoBaja: str(c.motivo_baja)`.
- `infrastructure/adapters/prisma/PrismaClientMirrorRepository.ts` → `upsertContract` agrega `motivoBaja: k.motivoBaja ?? null` al `data` block (L164-181), GR-owned (GR-wins como `vendedor`, L175-176). `InMemoryClientMirrorRepository.upsertContract` guarda el `GrContract` entero (L46) → fluye solo.
- `SyncGestionRealContractsDelta.execute()` YA forwarda el `GrContract` completo a `upsertContract` → **CERO cambios en el use case** (touch mínimo; seguro para la sesión paralela del EPIC F1). **F0 spike verificó** que el delta `action:contratos` trae `motivo_baja` ("CAMBIO DE TITULARIDAD") para ambos lados del par (BACKLOG EPIC card).
**Forward-only**: SIN backfill histórico — sólo los syncs futuros pueblan `motivoBaja`. La cobertura de la señal (d) crece con el tiempo. Limitación aceptada (documentada en proposal + spec).

### Decisión 6 (NUEVA, CRÍTICA) — señal (d) en tiempo de match desde AMBAS fuentes (source-agnostic)
**Choice**: el helper `matchActiveClient` recibe `churnReasonTexts: string[]` y dispara `'churn_reason'` si ALGÚN texto contiene "titularidad" (case-insensitive). El helper NO conoce la fuente. El **caller** arma el array: `[lead.churnReason, ...motivoBaja de los contratos del propio cliente del lead]` (filtrando null).
**Alternatives**: (A) sólo `lead.churnReason` poblado por `IngestChurnedClients` — pero el ingest es create-only/idempotente → NO re-estampa leads viejos → requeriría **backfill de leads**. (B) match-time desde ambas fuentes — elegida.
**Rationale**: el delta puede poblar el `motivoBaja` de un contrato DESPUÉS de que el lead ya existe; con (A) ese lead viejo nunca dispararía (d) sin backfill. Con (B), el lead viejo empieza a disparar (d) apenas su contrato lleva el motivo — **sin backfill de leads** (exactamente el requisito del scope). El poblado en el ingest (Decisión 5b, abajo) SIGUE siendo valioso: da a los leads nuevos un `churnReason` durable/visible en el drawer y converge CSV + churned en un campo.
**Mecanismo — CERO query extra (piggyback)**: el motivo del contrato se lee del MISMO batch por página `ContractRepository.findContractTechnologiesByClientIds(clientIds)` que YA corre para la columna Tecnología (`ListRecaptureLeads` L49, lee TODOS los contratos de los clientes de la página en cualquier estado). Se extiende su fila con `motivoBaja: string | null` → sin N+1, sin query nueva en el path de listado. `GetRecaptureLead` (single lead) lee el motivo del contrato del único `clientId` (no es N+1).

### Decisión 5b (NUEVA) — poblar `churnReason` en `IngestChurnedClients`
`IngestChurnedClients` gana `ContractRepository`; batch-lee los `motivoBaja` de los contratos por `clientIds` (misma proyección extendida) y pasa `churnReason` por cliente a `recaptureRepo.ingestChurned(...)`. `ingestChurned` (port + Prisma L217-242 + InMemory) acepta `churnReason?: string | null` y lo escribe en el CREATE (L226-232). Create-only/idempotente → no re-estampa existentes.

## Data Flow
```
GET /leads?page → ListRecaptureLeads.execute
  ├─ repo.list(query)                    → page leads (≤25)        [existe]
  ├─ contractRepo.findContractTech…(ids) → {tech, plan, motivoBaja}[existe, +motivoBaja]
  └─ customerRepo.listActiveContacts()   → active set (1 query)    [NEW]
        └─ matchActiveClient(lead, set, churnReasonTexts) → signals[]  (puro, por lead)
             churnReasonTexts = [lead.churnReason, ...motivoBaja(lead.clientId)]  ← ambas fuentes
  (try/catch → fail-open [])
GET /leads/:id → GetRecaptureLead.execute
  ├─ repo.getById(id)                    → lead+contacts           [existe]
  ├─ contractRepo.findContractTech…([id])→ motivoBaja del cliente  [NEW dep en Get]
  └─ customerRepo.listActiveContacts()   → set + MISMO helper → possibleActiveMatch rico (array)

# Persistencia (fuera del path HTTP, en el sync):
delta contratos → SyncGestionRealContractsDelta.execute → mirror.upsertContract(GrContract)
  → Contract.motivoBaja = motivo_baja  [aditivo; execute() sin cambios]
IngestChurnedClients.execute → contractRepo.findContractTech…(bajaIds) → churnReason por cliente
  → recaptureRepo.ingestChurned(clients, churnReason)  [create-only]
```

## File Changes
| File | Action | Description |
|------|--------|-------------|
| `application/use-cases/recapture/matchActiveClient.ts` | Create | Helper puro: normalizePhone + suffixMatch + email exact + churn substring (source-agnostic `churnReasonTexts`) + reactivated; devuelve `matchedClients[]` |
| `application/use-cases/recapture/ListRecaptureLeads.ts` | Modify | +`customerRepo` (3er param); arma `churnReasonTexts` (churnReason + motivoBaja del contrato); fase enrich fail-open |
| `application/use-cases/recapture/GetRecaptureLead.ts` | Modify | +`customerRepo` **y** +`contractRepo`; `possibleActiveMatch` rico (array); `churnReasonTexts` |
| `application/use-cases/recapture/IngestChurnedClients.ts` | Modify | +`contractRepo`; puebla `churnReason` desde `motivoBaja` del contrato de baja |
| `application/dto/recapture/recapture.dto.ts` | Modify | `possibleActiveMatchSignals` (list) + `possibleActiveMatch: {signals; matchedClients[]}` (detail) |
| `domain/ports/CustomerRepository.ts` (+Prisma+InMemory) | Modify | +`listActiveContacts(): Promise<ActiveClientContact[]>` |
| `domain/ports/ContractRepository.ts` (+Prisma+InMemory) | Modify | `findContractTechnologiesByClientIds` fila +`motivoBaja: string\|null` (piggyback) |
| `domain/ports/RecaptureRepository.ts` (+Prisma+InMemory) | Modify | `ingestChurned(...)` acepta `churnReason?` por cliente; escribe en el CREATE |
| `domain/entities/gestionReal.ts` | Modify | `GrContract` += `motivoBaja: string \| null` |
| `infrastructure/adapters/gestion-real/GestionRealClient.ts` | Modify | 2 parsers mapean `motivo_baja` → `motivoBaja` |
| `infrastructure/adapters/prisma/PrismaClientMirrorRepository.ts` (+InMemory) | Modify | `upsertContract` persiste `motivoBaja` (GR-owned, `data` block L164-181) |
| `prisma/schema.prisma` + `prisma/migrations/20260831000000_contract_motivo_baja/migration.sql` | Create | `Contract.motivoBaja` TEXT nullable (aditivo) |
| `infrastructure/http/app.ts` | Modify | `customerAdapter`→List/Get; `contractRepo`→Get e IngestChurnedClients (singletons ya existen, L2337-2341) — CERO singleton nuevo |
| FE `types/recaptacion.ts`, `RecaptacionTableView.tsx`, `LeadDetailDrawer.tsx` | Modify | Union+labels; badge inline; sección match (array) |

## Interfaces
```ts
export type ActiveMatchSignal = 'phone'|'email'|'reactivated'|'churn_reason';
export interface ActiveClientContact { id:string; name:string; phone:string; email:string }
export interface MatchedClientSummary {
  clientId:string; name:string; status:CustomerStatus;
  matchedBy:('phone'|'email'|'reactivated')[];
}
interface Lead { clientId:string|null; phone:string|null; email:string|null }
// SOURCE-AGNOSTIC churn input: the caller assembles churnReasonTexts from BOTH
// lead.churnReason (CSV/ingest) AND the lead's client's persisted Contract.motivoBaja.
export function matchActiveClient(
  lead: Lead,
  active: ActiveClientContact[],
  churnReasonTexts: string[],
): { signals: ActiveMatchSignal[]; matchedClients: MatchedClientSummary[] };
// DTO (ARRAY shape — spec.md authoritative, was singular in an earlier sketch):
//   RecaptureLeadListItemDto += possibleActiveMatchSignals: ActiveMatchSignal[]
//   RecaptureLeadDetailDto   += possibleActiveMatch: { signals: ActiveMatchSignal[]; matchedClients: MatchedClientSummary[] }
// 'churn_reason' vive en signals pero NO cuelga de ningún matchedClients[i] (es del lead, no de un cliente).
```

## FE Design
- **Badge**: inline junto a `contactName` en la celda "Contacto" (no columna nueva — la tabla ya tiene 7 cols + inline-assign; una 8va casi-vacía es ruido). Renderiza sólo si `signals.length>0` (ausencia = caso común, sin dash). Token `--badge-late` (rojo, libre en esta página) sobre `--badge-blocked` (naranja, COLISIONA con badge Wireless en la misma fila). **Final visual → ui-ux-pro-max en apply.**
- **Drawer**: `<section>` "Posible cliente activo" tras "Información", patrón `view.*`, renderiza con `possibleActiveMatch`. Chips de señales + itera `matchedClients[i]` (name/status/`matchedBy`) con un botón "Ver contratos del match" por cada uno, reusando `ContractHistoryModal` con `matchedClients[i].clientId` (cero código nuevo de fetch). Caso `churn_reason` sin cliente → sección visible sin botón de contratos.
- **TanStack Query**: sin invalidaciones nuevas; los campos viajan en los payloads existentes (`useRecaptacionLeads`/`useRecaptacionLead`, staleTime 30s intacto).
- **Types**: `possibleActiveMatchSignals?` y `possibleActiveMatch?` OPCIONALES en el `RecaptureLeadDto` unificado (evita la mentira required-pero-ausente de `technologies`); guard `?? []`/`?? null`.

## Testing Strategy
| Layer | Qué | Cómo |
|-------|-----|------|
| Unit | `matchActiveClient`/`normalizePhone` (tabla de casos, garbage no-throw, excluir clientId propio, reactivated, churn desde `churnReasonTexts` source-agnostic, dedup `matchedClients[]`) | Arrays planos, SIN repo |
| Parser | `parseContractsDeltaResponse`/`parseContractsResponse` mapean `motivo_baja` → `motivoBaja` | fixtures GR, sin red |
| Mirror | `upsertContract` persiste `motivoBaja` (create+update, null passthrough) | Prisma/InMemory mirror tests |
| Ingest | `IngestChurnedClients` puebla `churnReason` desde el contrato; idempotente no re-estampa | InMemoryRecapture + InMemoryContract |
| Use-case | signals en DTO, 1 sola query (N+1), `churnReasonTexts` desde ambas fuentes (contrato dispara sin churnReason), fail-open ante stub que throw | InMemoryRecaptureRepo + `jest.fn` CustomerRepository + Contract stub |
| Route | campos presentes, perm `recapture.read` intacto | supertest |
| FE | badge con/sin signals; sección match itera `matchedClients[i]` y reusa ContractHistoryModal(matchedClients[i].clientId) | vitest, extend describe-per-feature |

## Perf / índice
El diseño NO filtra por `phone` en SQL → el `Client.phone` sin índice es IRRELEVANTE (ventaja sobre opción A, que lo necesitaba). Único índice usado = `status` (existe). Costo = filas pulled (~10-14k, 4 cols). Follow-up SÓLO si perfila mal: memoizar el set (base cambia lento) — deferido por prematuro.

## Migration / Rollout
**1 migración aditiva**: `20260831000000_contract_motivo_baja` = `ALTER TABLE "Contract" ADD COLUMN "motivoBaja" TEXT;` (nullable). Generada con `prisma migrate diff --from-schema-datamodel <prev> --to-schema-datamodel prisma/schema.prisma --script` (Prisma 7); desplegada con `prisma migrate deploy` (additive = safe, sin lock ni backfill). Timestamp DESPUÉS del último (`20260830000000_pppoe_change_audit`). El resto es aditivo (DTOs, métodos, helper, badge FE). Rollback = revert commits BE+FE; la columna nullable puede quedar sin uso (drop opcional, no urgente). FE tolera ausencia de campos.

## Open Questions — RESUELTAS
- [x] Sufijo de teléfono = **8 dígitos** (recall-first). CONFIRMADO por el usuario (2026-07-10).
- [x] Señal (d) **NO es CSV-only**: se PERSISTE `motivo_baja` (Decisión 5) y se computa desde ambas fuentes en tiempo de match (Decisión 6). Forward-only aceptado. Pre-empta la decisión abierta del EPIC F2 (persist > inline); F2 consume el campo persistido.
