# Proposal: Recaptación — detector "posible cliente activo" (recapture-active-client-match)

## Intent

En Recaptación se llaman leads (ex-clientes) que en realidad SIGUEN activos bajo otra titularidad (servicio a nombre de pareja/familiar) o se re-dieron de alta → llamada perdida + papelón. Agregar una señal **informativa** que avise "posible cliente activo": badge en la fila de la tabla + detalle del match en el drawer. NO muta el lead, NO agrega acciones.

## Scope

### In Scope
- **BE list**: enrich de `GET /api/recapture/leads` con `possibleActiveMatchSignals: Array<'phone'|'email'|'reactivated'|'churn_reason'>` (vacío = sin match), batch por página (clon del patrón Tecnología, SIN N+1).
- **BE detail**: `GET /api/recapture/leads/:id` devuelve el match rico (cliente matcheado: id/name/status + flag reactivated + señales) → `GetRecaptureLead` gana dependencia `CustomerRepository`.
- **Helper puro** `matchActiveClient` (capa application, análogo a `deriveTechnology`): normalización de teléfono + comparación por sufijo + substring de motivo de baja. Input de churn **source-agnostic** (`churnReasonTexts: string[]`) → reusable por el detector del EPIC Titularidad F2 sin acoplar a la fuente.
- **Señales**: (a) teléfono normalizado, (b) email lowercase+trim exacto, (c) re-alta (`lead.clientId` volvió a `active`), (d) motivo de baja menciona "titularidad" — computada **en tiempo de match desde AMBAS fuentes**: `lead.churnReason` (CSV/ingest) **y** el `motivoBaja` persistido del contrato del propio cliente del lead. Ya NO es CSV-only (ver Risks + limitación forward-only).
- **Persistencia de `motivo_baja` (GR) — NUEVO en scope**: migración aditiva `Contract.motivoBaja` (TEXT nullable, mirror field GR-owned al estilo de `vendedor`) + write en el delta sync (`SyncGestionRealContractsDelta` → `ClientMirrorRepository.upsertContract`) parseando `motivo_baja` del feed `contratos` (F0 spike verificó que el delta lo trae: "CAMBIO DE TITULARIDAD" en ambos lados del par). **Forward-only**: sólo los syncs futuros pueblan el campo — SIN backfill histórico de GR; la cobertura de la señal (d) crece con el tiempo.
- **Poblado de `churnReason` — NUEVO en scope**: `IngestChurnedClients` estampa `RecaptureLead.churnReason` desde el `motivoBaja` persistido del contrato de baja al CREAR el lead `churned_client`. El ingest es create-only/idempotente → NO re-estampa leads ya existentes (esos los cubre la lectura del contrato en tiempo de match, sin backfill de leads).
- **FE**: badge en `RecaptacionTableView` + sección de match en `LeadDetailDrawer` (reusa `ContractHistoryModal` con el `matchedClientId` para los contratos). ui-ux-pro-max en design/apply.

### Out of Scope
- Cualquier mutación/acción sobre el lead ("descartar con un click") — futuro.
- **Backfill histórico de `motivo_baja`** en los contratos ya espejados (forward-only por decisión; sólo los syncs futuros pueblan `Contract.motivoBaja`).
- El **detector + pairing + casos persistidos + page "Acciones"** del EPIC Titularidad F2 — este change SÓLO persiste `motivo_baja`; F2 lo consume ya persistido (ver Dependencies).
- Índice sobre `Client.phone` (perf futura).
- Filtro por match en la FilterBar (es informativo).

## Capabilities

### New Capabilities
- `recapture-active-client-match`: reglas de detección informativa de "posible cliente activo" sobre leads de Recaptación (4 señales), enrich batch en el listado + detalle rico en el GET single, sin mutación.

### Modified Capabilities
- None (no hay spec `recapture` previo en `openspec/specs/`; el comportamiento existente de list/detail no cambia, solo se agregan campos).

## Approach

Clonar estructuralmente el patrón Tecnología (`34ae3c8c`):
1. **Match por contacto (a/b)**: OR-query pure-Prisma **scoped a la página** (`status:'active'` + `email in [...]` / `phone contains suffix`), NO full-scan. Excluir el propio `clientId` del lead (la señal c lo cubre).
2. **Normalización de teléfono** (helper puro, determinístico): quitar no-dígitos → quitar prefijos `+54` / `0` / `9` / `15` → **comparar los últimos 8 dígitos**. Elijo 8 (no 10) para maximizar recall: sobrevive a que un lado incluya/omita el código de área; un falso positivo (dos áreas con la misma cola de 8) es tolerable en un badge informativo, un falso negativo desperdicia la feature.
3. **Split de riqueza** (precedente): la lista sólo lleva el `string[]` de señales en `RecaptureLeadListItemDto`; `GetRecaptureLead` hace su propio lookup rico via `CustomerRepository`.
4. **Señal (d) desde ambas fuentes (en tiempo de match)**: el helper recibe `churnReasonTexts: string[]` (source-agnostic) y dispara `'churn_reason'` si ALGÚN texto contiene "titularidad" (case-insensitive). El caller arma el array con `lead.churnReason` (CSV/ingest) **+** el `motivoBaja` persistido del contrato del propio cliente del lead. El motivo del contrato se lee en el MISMO batch por página `findContractTechnologiesByClientIds` (ya existe para la columna Tecnología; se extiende su proyección con `motivoBaja` → CERO query extra, sin N+1). Esto hace que los **leads viejos** (churnReason null, sin backfill) empiecen a disparar (d) en cuanto un sync futuro pueble el `motivoBaja` de su contrato — sin backfill de leads.
5. **Persistencia GR-owned**: `SyncGestionRealContractsDelta` ya forwarda el `GrContract` entero a `upsertContract`; el write de `motivoBaja` es aditivo en el `data` block de `PrismaClientMirrorRepository.upsertContract` (más el parseo en `parseContractsDeltaResponse`/`parseContractsResponse` y el campo en la entidad `GrContract`). El cuerpo de `execute()` NO se toca → touch mínimo, seguro para la sesión paralela del EPIC F1.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `application/use-cases/recapture/ListRecaptureLeads.ts` | Modified | Batch enrich con señales por página; arma `churnReasonTexts` (churnReason + motivo del contrato) |
| `application/use-cases/recapture/GetRecaptureLead.ts` | Modified | Gana `CustomerRepository` **y** `ContractRepository`; detalle del match; `churnReasonTexts` |
| `application/use-cases/recapture/matchActiveClient.ts` | New | Helper puro (normalize + suffix + churn substring source-agnostic) |
| `application/use-cases/recapture/IngestChurnedClients.ts` | Modified | Gana `ContractRepository`; puebla `churnReason` desde el `motivoBaja` del contrato de baja |
| `application/dto/recapture/recapture.dto.ts` | Modified | Señales en list DTO + match (array) en detail DTO |
| `domain/ports/CustomerRepository.ts` (+ Prisma/InMemory) | Modified | `listActiveContacts()` (set de activos de la página) |
| `domain/ports/ContractRepository.ts` (+ Prisma/InMemory) | Modified | `findContractTechnologiesByClientIds` extiende su fila con `motivoBaja` (piggyback) |
| `domain/ports/RecaptureRepository.ts` (+ Prisma/InMemory) | Modified | `ingestChurned(...)` acepta `churnReason?` por cliente |
| `domain/entities/gestionReal.ts` | Modified | `GrContract` gana `motivoBaja: string \| null` |
| `infrastructure/adapters/gestion-real/GestionRealClient.ts` | Modified | 2 parsers de contratos mapean `motivo_baja` → `motivoBaja` |
| `infrastructure/adapters/prisma/PrismaClientMirrorRepository.ts` (+ InMemory) | Modified | `upsertContract` persiste `motivoBaja` (GR-owned, aditivo) |
| `prisma/schema.prisma` + `prisma/migrations/20260831000000_contract_motivo_baja/` | New | `Contract.motivoBaja` TEXT nullable — migración aditiva |
| `infrastructure/http/app.ts` | Modified | `customerAdapter` a List/Get + `contractRepo` a Get e IngestChurnedClients (singletons ya existen, L2337-2341) |
| FE `RecaptacionTableView.tsx`, `LeadDetailDrawer.tsx`, `types/recaptacion.ts` | Modified | Badge + sección de match (ui-ux-pro-max) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Señal (d) tenía cobertura sólo CSV (no-op para `churned_client`, la fuente dominante) | ~~High~~ Resuelto | **Ya NO es CSV-only**: este change persiste `motivo_baja` en `Contract.motivoBaja` y la señal (d) lo lee en tiempo de match. Cobertura ahora alcanza a `churned_client`. |
| Cobertura de (d) parcial al inicio por ser **forward-only** (sin backfill histórico) | Med | **Aceptado y documentado.** Sólo los syncs futuros pueblan `motivoBaja`; la cobertura crece con el tiempo. Un backfill histórico es follow-up opcional, fuera de scope. |
| El write de `motivo_baja` colisiona con la sesión paralela del EPIC F1 sobre el delta sync | Med | El touch es **aditivo y mínimo**: campo en `GrContract`, mapeo en los parsers, línea en el `data` block de `upsertContract`. El cuerpo de `SyncGestionRealContractsDelta.execute()` NO se toca. Coordinado con F1 (ver Dependencies). |
| Falso positivo del sufijo de 8 dígitos | Med | Aceptable en badge informativo; 8 CONFIRMADO por el usuario (recall-first); se puede subir a 10 si molesta |
| `phone contains` no usa índice (no hay index en `Client.phone`) a escala prod (~14.5k) | Med | El pass `status:'active'` es index-assisted; scoped a ≤25 leads/página. Índice = follow-up, fuera de scope |
| `LIKE` no normaliza guiones/espacios en el valor STORED de `Client.phone` | Low | Precisión/recall degradada aceptada; deuda documentada |
| Crecimiento del God Object `app.ts` (617 líneas) | Low | Params extra a use cases ya construidos (customerAdapter/contractRepo a List/Get/Ingest) — singletons ya existen, CERO nuevo |
| FE type mismatch (precedente `technologies` required-pero-ausente) | Low | El match se computa en list Y detail → campo siempre presente; tipar coherente |

## Rollback Plan
Cambio aditivo (campos nuevos en DTOs, métodos nuevos de repo, helper nuevo, badge FE) **+ 1 migración aditiva** (`Contract.motivoBaja` TEXT nullable). Revert = revertir los commits BE + FE; la columna nullable puede quedar sin usar (drop opcional en un revert de migración, no urgente — additive = safe). El FE tolera la ausencia de los campos (badge vacío → nada).

## Dependencies
- Ninguna externa.
- **Coordinación con EPIC Titularidad F1 (sesión paralela)**: F1 trabaja sobre el flujo de transferencia/eventos; puede tocar código compartido del delta sync. Este change mantiene su touch en `SyncGestionRealContractsDelta` **aditivo y mínimo** (no reestructura `execute()`). Si hay conflicto, gana el que mergea primero y el otro rebasa el diff aditivo.
- **Coordinación con EPIC Titularidad F2**: este change ADELANTA la decisión abierta de F2 ("persistir `motivo_baja` vs. detectar inline") a favor de **PERSISTIR**. F2 consume `Contract.motivoBaja` ya persistido (pairing, page "Acciones"). Sinergia adicional: F2 puede reusar el helper `matchActiveClient` (churn source-agnostic).

## Success Criteria
- [ ] Lead que matchea un cliente `active` por teléfono/email (≠ su propio clientId) muestra el badge en la tabla.
- [ ] El drawer muestra quién matcheó, por qué señal(es) y permite ver los contratos del cliente matcheado.
- [ ] Re-alta del mismo cliente (señal c) se detecta aunque no haya match de contacto.
- [ ] Cero N+1: una sola query de clientes por página.
- [ ] Cero mutación de leads. `tsc --noEmit` limpio + suite verde (BE y FE).

## Decisions (resueltas por el usuario, 2026-07-10 — post-planning)
1. ✅ **Señal (d) NO es CSV-only**: se persiste `motivo_baja` de GR (migración aditiva `Contract.motivoBaja` + write en el delta sync + poblado en `IngestChurnedClients`) y (d) se computa en tiempo de match desde ambas fuentes. **Forward-only** (sin backfill histórico) aceptado.
2. ✅ **Sufijo de teléfono = últimos 8 dígitos** (prioriza recall). CONFIRMADO.
3. ✅ **PERSIST > inline** para `motivo_baja` (pre-empta la decisión abierta del EPIC F2; F2 lo consume persistido).
4. **Color del badge**: recomendación del explore = `--badge-late` (rojo, libre en esta página); evitar `--badge-blocked` (naranja) que colisiona con el badge Wireless. Final → design + ui-ux-pro-max.
