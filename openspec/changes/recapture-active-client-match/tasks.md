# Tasks: Recaptación — detector "posible cliente activo" (recapture-active-client-match)

Two repos, two worktrees, one branch name: `recapture-active-match-be` / `recapture-active-match-fe`, both on `feat/recapture-active-match`. BE ships + deploys FIRST; FE starts only after BE is pushed (additive contract, no breaking window).

## 0. Wire Contract (verbatim, BOTH repos — spec.md is authoritative)
```ts
type ActiveMatchSignal = 'phone' | 'email' | 'reactivated' | 'churn_reason';
interface MatchedClientSummary { clientId: string; name: string; status: CustomerStatus; matchedBy: ('phone'|'email'|'reactivated')[] }
// list item:
possibleActiveMatchSignals: ActiveMatchSignal[]
// detail:
possibleActiveMatch: { signals: ActiveMatchSignal[]; matchedClients: MatchedClientSummary[] }
// helper (SOURCE-AGNOSTIC churn input — the caller merges lead.churnReason + Contract.motivoBaja):
matchActiveClient(lead, activeContacts, churnReasonTexts: string[]) → { signals, matchedClients }
```
**Design.md reconciled (2026-07-10)**: an earlier design.md Interfaces sketch used `activeMatch` + singular `matchedClient`; design.md was amended to the ARRAY `matchedClients` + field `possibleActiveMatch` (spec.md's Contract + "Cardinalidad" requirement remain authoritative). Both artifacts now agree; use these names/shapes in both repos.

## 1. BE — Helper puro + Port (Dominio/Aplicación)
- [x] 1.1 RED `src/__tests__/application/recapture/matchActiveClient.test.ts`: normalizePhone table (design §Decisión 2) + suffixMatch + email exact/trim/case + **churn substring sobre `churnReasonTexts: string[]` source-agnostic** (dispara si algún texto contiene "titularidad"; `[]` → no dispara) + reactivated + exclude own `clientId` + null/garbage no-throw + 2-client dedup. Pins S2,S3,S4a,S4b,S5,S6a,S6b,S7a,S7b,S8.
- [x] 1.2 GREEN `src/application/use-cases/recapture/matchActiveClient.ts`: `normalizePhone`, `suffixMatch`, `matchActiveClient(lead, activeContacts, churnReasonTexts) → {signals, matchedClients}` (Wire Contract shape; el helper NO conoce la fuente del churn). Total function, never throws.
- [x] 1.3 `src/domain/ports/CustomerRepository.ts`: add `ActiveClientContact {id,name,phone,email}` + `listActiveContacts(): Promise<ActiveClientContact[]>`.

## 2. BE — Prisma Adapter
- [x] 2.1 RED extend `src/__tests__/infrastructure/PrismaCustomerRepository.mappers.test.ts`: `toActiveClientContact(row)` — full row, null phone/email.
- [x] 2.2 GREEN `src/infrastructure/adapters/prisma/PrismaCustomerRepository.ts`: export `toActiveClientContact`; `listActiveContacts()` = `findMany({where:{status:'active'},select:{id,name,phone,email}})` mapped. Pure Prisma, no `$queryRaw`, no new index needed.

## 3. BE — DTO + Use Cases (Aplicación)
- [x] 3.1 `src/application/dto/recapture/recapture.dto.ts`: add `ActiveMatchSignal`, `MatchedClientSummary`; `RecaptureLeadListItemDto.possibleActiveMatchSignals`; `RecaptureLeadDetailDto.possibleActiveMatch` (assembled in use case, NOT inside `toRecaptureLeadDto`/`toRecaptureLeadDetailDto`).
- [x] 3.2 RED extend `src/__tests__/application/recapture/recapture.usecases.test.ts` (`ListRecaptureLeads`): signals per page via stub `CustomerRepository` (`{ listActiveContacts: jest.fn() }` — established jest-stub convention per design, no new InMemory adapter class); exactly ONE call/page; empty page → zero calls; fail-open (`[]`) when stub throws. Pins S1a,S1b.
- [x] 3.3 GREEN `ListRecaptureLeads.ts`: +3rd param `customerRepo: CustomerRepository`; enrich phase in try/catch, ONE `listActiveContacts()` call reused across the page.
- [x] 3.4 RED extend same file for `GetRecaptureLead`: rich `possibleActiveMatch` incl. 2-client cardinality (S8 detail side), no-match shape `{signals:[],matchedClients:[]}` (S9a), churn-only-no-client (S9b), fail-open, no mutation of lead/client on repeat call (S10).
- [x] 3.5 GREEN `GetRecaptureLead.ts`: +2nd param `customerRepo`; build `possibleActiveMatch` via same helper.

  > NOTE (Batch 2): `churnReasonTexts` in both use cases is currently `lead.churnReason ? [lead.churnReason] : []` ONLY — the `Contract.motivoBaja` source (3A/3B) is NOT yet merged in. The seam is exactly where Batch 3B's `[lead.churnReason, ...motivoBaja(lead.clientId)].filter(Boolean)` replaces this one-liner in both `ListRecaptureLeads.ts` and `GetRecaptureLead.ts`.

## 3A. BE — Persistir `motivo_baja` de GR en el mirror (migración + entidad + parsers + write) [SCOPE EXPANSION]
> Aditivo y mínimo: el cuerpo de `SyncGestionRealContractsDelta.execute()` NO se toca (ya forwarda el `GrContract` completo). Paralelo seguro con la sesión del EPIC F1.
- [x] 3A.1 Schema + migración: agregar `motivoBaja String?` a `Contract` en `prisma/schema.prisma` (junto a `vendedor`); generar `prisma/migrations/20260831000000_contract_motivo_baja/migration.sql` con `npx prisma migrate diff --from-schema-datamodel <schema previo> --to-schema-datamodel prisma/schema.prisma --script` (Prisma 7) → `ALTER TABLE "Contract" ADD COLUMN "motivoBaja" TEXT;`. Aditiva/nullable; deploy con `prisma migrate deploy`. Timestamp DESPUÉS de `20260830000000_pppoe_change_audit`.
- [x] 3A.2 `src/domain/entities/gestionReal.ts`: `GrContract` += `motivoBaja: string | null` (junto a `vendedor`).
- [x] 3A.3 RED extend `src/__tests__/infrastructure/adapters/gestion-real/gestionReal.contractsDelta.parser.test.ts`: `parseContractsDeltaResponse` mapea `motivo_baja` → `motivoBaja` (presente + ausente→null); idem `parseContractsResponse` (per-cliente).
- [x] 3A.4 GREEN `src/infrastructure/adapters/gestion-real/GestionRealClient.ts`: ambos parsers `motivoBaja: str(c.motivo_baja)` (delta L263-277 + per-cliente L236-250).
- [x] 3A.5 RED extend `src/__tests__/infrastructure/PrismaClientMirrorRepository.upsertData.test.ts` + `src/__tests__/infrastructure/adapters/in-memory/InMemoryClientMirrorRepository.upsertContract.test.ts`: `upsertContract` persiste `motivoBaja` (create + update; null passthrough). Pins S14a, S14b.
- [x] 3A.6 GREEN `PrismaClientMirrorRepository.upsertContract`: `data` block += `motivoBaja: k.motivoBaja ?? null` (GR-owned, junto a `vendedor` L175-176). InMemory ya guarda el `GrContract` entero → verificar shape. **NO tocar** `SyncGestionRealContractsDelta.execute()`.

## 3B. BE — Proyección de motivo + `churnReason` en ingest + señal (d) desde ambas fuentes [SCOPE EXPANSION]
- [x] 3B.1 `src/domain/ports/ContractRepository.ts` (+Prisma+InMemory): extender la fila de `findContractTechnologiesByClientIds` con `motivoBaja: string | null` (`select` += `motivoBaja`); actualizar doc (es el batch de enrich por página, todos los estados). CERO query nueva (piggyback del batch de Tecnología).
- [x] 3B.2 RED extend `src/__tests__/application/recapture/recapture.usecases.test.ts` (IngestChurnedClients describe — no existe archivo dedicado, ver Deviations): cliente baja con contrato `motivoBaja` → lead nuevo con `churnReason` = ese motivo; ingest idempotente NO re-estampa un lead existente. Pins S15a, S15b.
- [x] 3B.3 GREEN `IngestChurnedClients.ts`: +`contractRepo`; batch-lee `motivoBaja` por `clientIds`; pasa `churnReason` por cliente. Extender `RecaptureRepository.ingestChurned(...)` (port) para aceptar `churnReason?: string | null` y escribirlo en el CREATE (Prisma L226-232 + InMemory).
- [x] 3B.4 RED extend `src/__tests__/application/recapture/recapture.usecases.test.ts`: `ListRecaptureLeads` y `GetRecaptureLead` — lead `churned_client` con `churnReason=null` pero contrato con `motivoBaja` "titularidad" dispara `'churn_reason'` (list + detail); un lead CSV con churnReason "titularidad" sigue disparando. Pins S16a.
- [x] 3B.5 GREEN `ListRecaptureLeads.ts` + `GetRecaptureLead.ts`: armar `churnReasonTexts = [lead.churnReason, ...motivoBaja(lead.clientId)]` (filtrar null) y pasarlo al helper. List reusa el batch extendido (L49, ya corre para Tecnología); `GetRecaptureLead` gana `contractRepo` (3er dep) y lee el motivo del único `clientId`.

## 4. BE — Wiring + Routes (Infraestructura)
- [x] 4.1 `src/infrastructure/http/app.ts` (L2337–2341, all singletons already in scope — zero new): pass `customerAdapter` to `new ListRecaptureLeads(...)` + `new GetRecaptureLead(...)`; pass `contractRepo` to `new GetRecaptureLead(...)` (nuevo 3er dep) and to `new IngestChurnedClients(...)` (nuevo 2do dep tras recaptureRepo+customerAdapter).
- [x] 4.2 RED extend `recapture.routes.test.ts` + fix arity in `recapture-refine/csv/assign.routes.test.ts` stubs (+ `recapture-refine.test.ts` application-layer ripple, see Deviations): new fields present on list/detail responses; 403 without `recapture.read` unchanged (S11).
- [x] 4.3 GREEN: adjust only what compile/arity requires — zero guard/logic changes.

## 5. BE Gate (orchestrator runs directly, not a sub-agent task)
- [x] 5.1 `npm test` full suite green; `npx tsc --noEmit` clean.
- [ ] 5.2 Push BE (user-confirmed) — FE Phase 6 depends on this being deployed.

## 6. FE — Types + API (worktree `recapture-active-match-fe`, AFTER 5.2)
- [x] 6.1 Run `ui-ux-pro-max` skill (design-system search) before touching UI; confirm `--badge-late` token free (not colliding with Wireless badge).
- [x] 6.2 `src/types/recaptacion.ts`: add `ActiveMatchSignal`, `MatchedClientSummary`, `possibleActiveMatchSignals?` + `possibleActiveMatch?` — BOTH OPTIONAL on the unified `RecaptureLeadDto` (not split list/detail like BE — mirrors the `technologies` precedent decision to avoid a required-but-absent lie). Guard `?? []` / `?? null` at every read site.
- [x] 6.3 Confirm `src/api/recaptacion.api.ts` passes new fields through untouched (pass-through JSON, no manual mapper to edit).

## 7. FE — Badge + Drawer (TDD)
- [x] 7.1 RED `src/__tests__/customers/RecaptacionTableView.test.tsx`: badge shows when `signals.length>=1`, absent when `[]`/undefined; `technologies`/status pill unaffected. Pins S12.
- [x] 7.2 GREEN `RecaptacionTableView.tsx`: inline badge in "Contacto" cell (no 8th column), token `--badge-late`.
- [x] 7.3 RED `src/__tests__/customers/LeadDetailDrawer.test.tsx`: match section renders per `matchedClients[i]` (name/status/matchedBy chips) with "Ver contratos" opening `ContractHistoryModal` for THAT client's id (not the lead's own); churn-only case shows the flag with no contracts button (S13b); section absent when `signals` empty/undefined. Pins S13a,S13b.
- [x] 7.4 GREEN `LeadDetailDrawer.tsx`: generalize `showContracts:boolean` → `contractsClientId: string|null` (reused by the lead's own "Ver contratos" button too); render "Posible cliente activo" section after "Información".

## 8. FE Gate (orchestrator runs directly)
- [x] 8.1 `npx vitest run` green; `npx tsc --noEmit` clean.

## 9. Review, Verify, Close (orchestrator)
- [ ] 9.1 Adversarial review, 2 reviewers min: (a) correctness/normalization — phone edge cases, dedup, fail-open, exclude-own-clientId, churn source-agnostic; (b) contract/wiring — DTO names match §0 Wire Contract exactly, zero N+1 (motivo piggybacks the tech batch), app.ts arity, permission guard untouched, `SyncGestionRealContractsDelta.execute()` untouched, migration additive/nullable + timestamp after last.
- [ ] 9.2 sdd-verify: all 24 scenarios (S1a…S13b + S14a,S14b,S15a,S15b,S16a) mapped to a passing test, no CRITICAL open.
- [ ] 9.3 Push BE with migration (`prisma migrate deploy`, additive = safe) then FE (user-confirmed), after BE is live in prod.

**Out of scope (do NOT add tasks for)**: historical GR backfill of `motivo_baja` (forward-only by decision — only future syncs populate it); the EPIC Titularidad F2 detector/pairing/"Acciones" page (F2 CONSUMES the persisted `Contract.motivoBaja` this change adds); one-click discard action on the lead.

## Traceability legend (scenario → task)
- S1a,S1b → 3.2 · S2,S3,S4a,S4b,S5,S6a,S6b,S7a,S7b,S8 → 1.1 (helper) · S8 detail,S9a,S9b,S10 → 3.4 · S11 → 4.2 · S12 → 7.1 · S13a,S13b → 7.3
- **NEW**: S14a,S14b → 3A.5 (mirror persist) · S15a,S15b → 3B.2 (ingest populate) · S16a → 3B.4 (signal-d from contract at match time). 24 scenarios total (19 + 5).
