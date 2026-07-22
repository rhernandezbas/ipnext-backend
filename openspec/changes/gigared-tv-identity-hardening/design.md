# Design: gigared-tv-identity-hardening

## Technical Approach

Cierra el incidente Centeno/Vacherand endureciendo `RegisterGigaredAccount` con el **fix REAL**
confirmado por forense (engram `gigared/root-cause-cic-envenenado`): el register **dejaba de confiar
en el pool**. El partner recicla CICs vía `renewCic` (en `CancelTv`) que **vuelven al pool
`unregistered` cargando el `internal_id` del dueño anterior** (imposible de limpiar, #72); el
register elegía uno AL AZAR sin verificar → heredó la identidad de Vacherand. Los dos guardas nuevos
son (1) **filtrado del pool** al elegir el CIC y (2) **verificación post-stamp** de que MI identidad
resuelve. Sobre eso se mantienen las mejoras defensivas: recovery idempotente (D2), 207 (D3), lista
local-first (D4), evento `transferencia` (D7) y, NUEVO, el `newCic` en el evento `baja` (D-baja).

Todo aditivo: el happy path del write al partner (misma secuencia, 201) NO cambia — se agrega
filtrado (sobre el pool YA traído), una lectura de verificación, recovery (catch) y derivación local
(lista). CERO writes reales al partner en dev (fakes). La lógica de `seq`/`incrementSeq` NO se toca
(la incógnita del seq quedó CERRADA por la auditoría — ver D5). El **nombre BE-authoritative (D1) se
DEGRADA a hardening opcional** (no fue causal). Specs impactadas: `gigared-customer-tv` (POST
/register), `gigared-accounts` (GET /accounts, sin cambios vs. versión previa), `service-transfer`
(ADDED TV-3, sin cambios).

## Architecture Decisions

### D-pool — Anti-envenenamiento del pool (fix #1, NUEVO — la causa raíz)

**Choice**: Dos guardas en `RegisterGigaredAccount.execute`, alrededor del pool-pick actual
(`RegisterGigaredAccount.ts:113-120`):

**(1) Filtrado del pool al elegir el CIC.** Hoy: `const pool = await
this.gigared.listAccounts({ status: 'unregistered' }); ... poolEntry = pool[pickFn(pool.length)]`.
Nuevo: filtrar a los CICs LIMPIOS antes de elegir —
```ts
const pool = await this.gigared.listAccounts({ status: 'unregistered' });
if (pool.length === 0) throw new NoCicAvailableError();
const clean = pool.filter(e => e.cic && (e.internalId === null || e.internalId === ''));
if (clean.length === 0) throw new TvPoolPoisonedError(pool.length);   // todos envenenados
const poolEntry = clean[pickFn(clean.length)];
```
Un CIC "envenenado" es el que trae un `internal_id` no vacío (ajeno o propio-viejo) — residuo del
`renewCic` que no se pudo limpiar (#72). El `pick` (inyectable, #109) ahora indexa sobre `clean`.

**DECISIÓN DE DISEÑO RESUELTA — el listado del pool YA trae el `internalId`.** Verificado:
`GigaredPort.GigaredAccount` declara `internalId: string | null` (`GigaredPort.ts:37`) y el adapter
lo puebla para TODA cuenta del listado (`GigaredClient.ts:146` → `internalId: raw.internal_id`; la
fila cruda `RawAccount.internal_id` existe, `:63`; `listAccounts` mapea cada fila con `mapAccount`,
`:335`). Por lo tanto **el filtrado es GRATIS, en memoria, sin una sola llamada extra al partner** —
NO hace falta un probe-por-CIC-elegido. (El probe-por-elegido — `getAccountByCic` por candidato —
queda descartado: costaría N llamadas y el dato ya viene en el listado.)

**(2) Verificación post-stamp.** El código ya hace `const account = await
this.gigared.getAccountByInternalId(internalId)` (`:152`) tras `setInternalId`, pero **usa el
resultado a ciegas**. Nuevo: verificar que el `account` devuelto es el CIC que estampé —
```ts
const account = await this.gigared.getAccountByInternalId(internalId);
if (account.cic !== cic) throw new TvIdentityStampUnverifiedError(cic, internalId);
```
Si el readback 404ea (ya lanza `GigaredNotFoundError`) o devuelve OTRO CIC (el `internal_id`
append-only resolvió al dueño histórico, no al mío) → **NO reconciliar fila local a medias**. El
recovery del D2 lo levanta en el retry (idempotente).

**Alternatives**: (a) probe-por-elegido con `getAccountByCic` → N llamadas, rechazada (el listado ya
trae el `internalId`); (b) confiar en el pool + limpiar el CIC envenenado con `setInternalId(cic, '')`
→ IMPOSIBLE, el partner rechaza el internal_id vacío (#72, es justamente lo que originó las minas).

**Rationale**: es el fix de la causa raíz. El filtrado impide que una mina se use; la verificación
post-stamp corta antes de escribir una fila local sobre una identidad que el partner no confirmó
como mía. Ambos comparan contra MI `internalId` vigente — nunca confían en el primario (append-only,
miente). Composición con D2: como el register sólo estampa CICs LIMPIOS, **todo orphan NUEVO nace con
`internalId` vacío** → la rama "vacío → reanudar" del D2 es la correcta; la rama "ajeno → 409" cubre
el orphan HISTÓRICO envenenado (rehúsa auto-tocar cuenta bindeada a otro cliente). Los dos fixes
componen, no se contradicen.

### D2 — Recovery/probe idempotente (sin unlink) — se mantiene

**Choice**: Idempotency key = MI internalId `currentTvInternalId(customerId, seq)` + email
determinístico. **Probe-previo** `getAccountByInternalId(internalId)` ANTES del pool-pick: si
resuelve con `internalId === MI internalId` → MÍA ya estampada → saltear pool/register/activate/
setInternalId, sólo reconcile local (`recovered=true`). 404 → sigue al D-pool (pool-pick filtrado).
La secuencia partner se envuelve en try/catch gateado a **`err instanceof GigaredRejectedError`**
(infra errors Unavailable/Auth propagan intactos) y usa `listAccounts({ email })` como discriminador:
- match con `internalId === ''` → **MI huérfana** → reanudar `activate`+`setInternalId` con `match.cic`.
- match con `internalId === MI internalId` → completar sólo local.
- match con `internalId ≠ mío` (no vacío) → **`TvEmailOwnedByOtherError` (409)**, jamás robar.
- sin match → re-lanzar el `GigaredRejectedError` original.

**Rationale**: Un 2º POST idéntico sobre cuenta ya estampada NO re-registra ni consume CIC del pool.
**Alcance de idempotencia**: alta fresca (seq=0, caso del incidente) → idempotencia TOTAL. Compara
SIEMPRE contra MI internalId vigente. La verificación post-stamp del D-pool y este recovery son
complementarios: post-stamp corta el mismo call, el recovery completa el siguiente.

### D3 — 207 en POST /register (espejo link/addService) — se mantiene

**Choice**: Result pasa de `{account, credentialsPersisted}` a
`{account, partnerCreated, localReconciled: 'synced'|'failed', credentialsPersisted, recovered}`.
Ruta (`gigared.routes.ts:380`): `partial = !partnerCreated || localReconciled === 'failed'`;
`res.status(partial ? 207 : 201).json(result)`. Espejo exacto de link (`:294`) y transfer (`:340`).
Happy path sigue 201; 207 es un caso que hoy NO se distingue (mejora estricta, superset).

### D4 — Lista local-first: batch + fallback — se mantiene

**Choice**: Nuevo método batch en `ContractServiceRepository`:
`findActiveTvOwnersByCics(serviceCatalogId, cics: string[]): Promise<{ notes: string; clientId: string }[]>`.
Prisma: UNA query `findMany({ where:{ serviceCatalogId, status:'active', OR: cics.map(c=>({notes:{startsWith:`CIC ${c}`}})) }, select:{ notes:true, contract:{select:{clientId:true}} }, orderBy:{createdAt:'asc'} })`.
`ListGigaredAccounts` recibe deps OPCIONALES `(gigared, csRepo?, catalogRepo?)`: con ambas presentes
resuelve `tvCatalogId` (`catalogRepo.getByName('TV')`), llama el batch UNA vez, arma
`Map<cic, clientId>` con `cicFromNotes` (match EXACTO; primera fila gana). Cada cuenta:
`clientId = ownerByCic.get(a.cic) ?? aliasFallback(a)`. Sin deps → alias-only (byte-for-byte legacy).
N+1 PROHIBIDO (endpoint de operadores). `GetGigaredCustomerAccount` NO se toca.

### D6 — Errores nuevos

**Choice**: en `domain/errors/gigared.ts`, tres errores nuevos (los codes son el contrato de wire
FROZEN; la ruta mapea cada uno a un status pineado en `sendGigaredError`):
- **`TvPoolPoisonedError`** — code `TV_POOL_POISONED` → **422** (D-pool). Carga `poisonedCount`.
  Branch nuevo en `sendGigaredError` espejando `NoCicAvailableError` (`gigared.routes.ts:158` → 422).
  **Por qué 422 y no 503**: es una condición de DATOS determinística y NO transitoria (reintentar no
  ayuda hasta limpiar el pool), misma familia que `NO_CIC_AVAILABLE`; 503 (mis)señalaría "reintentá
  ya", que acá es falso.
- **`TvIdentityStampUnverifiedError`** — code `TV_IDENTITY_UNVERIFIED` → **503** (D-pool). Carga
  `cic` + `internalId`. **Por qué 503**: el write al partner tomó pero el readback no confirmó el
  binding (anomalía de consistencia del partner); el reintento es idempotente vía el probe/recovery
  del D2 → 503 le dice honestamente al FE "reintentá" y el retry se auto-completa.
- **`TvEmailOwnedByOtherError`** — code `TV_EMAIL_OWNED_BY_OTHER` → **409** (D2). Carga `email` +
  `ownedByInternalId`. Branch espejando `TvAlreadyLinkedError` (`gigared.routes.ts:168` → 409).

### D7 — Historial TV global: `TransferTvToCustomer` graba `transferencia` — se mantiene

**Choice**: `TvEventType` gana `'transferencia'` (columna `eventType` ya es `String` libre — CERO
migración). `TransferTvToCustomer` gana una dep OPCIONAL `activationEventRepo?:
TvActivationEventRepository` (constructor, AL FINAL) y graba DOS eventos `transferencia` best-effort
(nunca aborta): uno keyed al DESTINO (`contractId: targetContractId`, `reason: "Recibido por
transferencia de {origen}"`) y uno keyed al ORIGEN (`contractId` resuelto o `input.sourceContractId`,
`reason: "Transferido a {destino}"`). Se re-graban en RESUME (append-only). Wiring: `app.ts:2518`
pasa el MISMO singleton `gigaredTvActivationEventRepo` (`:2494`). Ver spec `service-transfer` (TV-3).

**Rationale**: cero migración, cero cambio en adapters, dependencia OPCIONAL → callers/tests sin
`activationEventRepo` byte-idénticos.

### D-baja — `newCic` del `renewCic` en el evento `baja` (fix #6, NUEVO — forense futura)

**Choice**: Hoy `CancelTvJobRunner.ts:59-67` graba el evento `baja` con `cic: result.cic` (el CIC
VIEJO) y **descarta `result.renew.newCic`** — el CIC nuevo que el partner acaba de reciclar al pool
CARGANDO el internal_id del cliente (la futura mina). `CancelTv.execute` YA devuelve
`renew: { oldCic, newCic } | null` (`CancelTv.ts:222-229,246`), así que el dato está en scope en el
call-site del evento. Se agrega el `newCic` al evento `baja` para que la próxima mina deje rastro
(hoy la forense fue arqueología: el newCic no figuraba en ningún lado).

**Cómo, sin migración**: `RecordTvActivationEventInput` no tiene campo `newCic` y la columna
dedicada exigiría migración. Consistente con el ethos "cero migración" de este change (D7), el
`newCic` se anexa al `reason` del `baja` en un sufijo estructurado y greppable, preservando el
motivo de baja del usuario (#127) como segmento inicial:
```ts
reason: [reason ?? null, result.renew?.newCic ? `renewCic:${result.renew.newCic}` : null]
          .filter(Boolean).join(' · ') || null
```
El tag `renewCic:{cic}` es grep-able para un futuro report de minas (deuda). **Alternative** (columna
`recycledCic` nueva + migración) → rechazada por ahora: más pesada y el reason-suffix cubre la
necesidad forense. Si el report de minas (deuda) se vuelve first-class, promover a columna es trivial.

### D1 — Nombre BE-authoritative + split APELLIDO-primero — DEGRADADO a hardening OPCIONAL

**Estado**: la forense probó **página correcta + nombre correcto** → el body-name NO fue el vector
del incidente. D1 deja de ser fix principal y pasa a **hardening OPCIONAL, último batch, marcado
opcional** (batch B8, ver tasks). Si no entra en v1, NO reabre el incidente.

**Choice (cuando el hardening entre)**: helper puro `splitCustomerName(name)` en aplicación (el
`Client` tiene UN solo campo `name`, `schema.prisma:174` — no hay firstName/lastName; extender el
port exigiría migración, out of scope). Convención **APELLIDO-primero** (PRIMER token = `lastName`,
resto = `firstName`) — **verificada contra prod**: "VACHERAND SILVIO GABRIEL" → last "VACHERAND";
"CENTENO MIGUEL ANGEL" → last "CENTENO"; y el email del incidente `centeno12213` es el PRIMER token.
**Confirmación independiente**: el FE (`GigaredPanel.tsx:58-67`, helper `splitName`, comentario "#47e
B: the FIRST token is the lastName") ya usa esa convención hace meses — el helper BE debe ser su
espejo. `RegisterGigaredAccount` deja de leer `input.firstName/lastName` y `deterministicTvEmail` usa
el `lastName` derivado. Vacío → fallback (`normalizeLastName` cae a `cliente`).

**Rationale**: mata un vector de corrupción TEÓRICO (no el confirmado). El split exacto es COSMÉTICO
(sólo el primer token `[a-z]` llega al email, ya unicificado por grContratoId+seq). Riesgo residual:
apellidos compuestos ("DE LA CRUZ") → email sub-óptimo pero determinístico.

### D5 — Verificación del seq — CERRADA (no fue causal)

**Resolución**: la incógnita del `seq=0/pelado` quedó **RESUELTA por la auditoría completa
(AuditEvent)**: NO hubo NINGÚN `LinkCustomerToCic` antes del manual (el primero fue el del
orquestador a las 16:04), y el register de Centeno tenía `seq=0` **correcto** (primera alta de un
cliente NO cancelado). El `internal_id` de Vacherand NO vino de la lógica de seq/link — vino del
**CIC reciclado del pool** (D-pool). Por lo tanto: **se elimina del scope** la task de verificación
del seq (ex-B1) y su fix condicional (ex-B1b). El guard #81 de register queda intacto y correcto.

**Deuda documentada (NO scope)**: `LinkCustomerToCic` sigue sin replicar el guard #81 — usa
`customer.tvActivationSeq` directo y no mintea identidad fresca en una re-alta vía link. Es un gap
teórico real pero **la forense probó que NO participó en este incidente**. Queda como NOTA de deuda,
no como task de este change.

## Data Flow — RegisterGigaredAccount (con fix #1)

    customerLookup ─→ contractLookup (ownership+grContratoId) ─→ pwd/email det. ─→ seq/internalId
                                                                                        │
                                              PROBE getAccountByInternalId(internalId)  │ (D2)
                                        ┌───────────────┴────────────────┐
                            mine-stamped│                                 │404
                            (skip writes,│                                ▼
                             recovered)  │   pool = listAccounts({unregistered})           (D-pool)
                                         │   clean = pool.filter(!internalId)   ← GRATIS, en memoria
                                         │     · clean.empty → 422 TV_POOL_POISONED (0 writes)
                                         │     · pick(clean) → register → activate → setInternalId
                                         │                    │ throw GigaredRejectedError
                                         │                    ▼
                                         │        listAccounts({email}): ''→resume · mine→local  (D2)
                                         │                    · other→409 TV_EMAIL_OWNED_BY_OTHER · none→rethrow
                                         │                    ▼
                                         │   account = getAccountByInternalId(internalId)  (D-pool #2)
                                         │     · account.cic !== cic → 503 TV_IDENTITY_UNVERIFIED (sin fila local)
                                         └───────────────┬────────────────┘
                                                         ▼
                              reconcile local (best-effort) → localReconciled synced|failed  (D3)
                                                         ▼
                              route: partial ? 207 : 201   { partnerCreated, localReconciled, credentialsPersisted, recovered }

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `application/use-cases/gigared/RegisterGigaredAccount.ts` | Modify | **pool-filter + post-stamp verify (D-pool, fix #1)**; probe+try/catch recovery (D2); result shape 207 (D3) |
| `domain/errors/gigared.ts` | Modify | `TvPoolPoisonedError` (422), `TvIdentityStampUnverifiedError` (503), `TvEmailOwnedByOtherError` (409) (D6) |
| `infrastructure/http/routes/gigared.routes.ts` | Modify | 207 en /register (:380); branches nuevos en `sendGigaredError` → 422/503/409 (D6) |
| `application/use-cases/gigared/ListGigaredAccounts.ts` | Modify | deps opcionales csRepo/catalogRepo; owner local-first batch + fallback alias (D4) |
| `domain/ports/ContractServiceRepository.ts` | Modify | `findActiveTvOwnersByCics(catalogId, cics[])` (D4) |
| `infrastructure/adapters/prisma/PrismaContractServiceRepository.ts` | Modify | impl batch: 1 findMany con JOIN a Contract (D4) |
| `infrastructure/adapters/in-memory/InMemoryContractServiceRepository.ts` | Modify | espejo in-memory del batch (D4) |
| `infrastructure/scheduling/CancelTvJobRunner.ts` | Modify | `newCic` (de `result.renew`) en el evento `baja`, sufijo en `reason` (D-baja, fix #6) |
| `domain/ports/TvActivationEventRepository.ts` | Modify | `TvEventType` gana `'transferencia'` (D7) |
| `application/use-cases/gigared/TransferTvToCustomer.ts` | Modify | dep opcional `activationEventRepo` + 2 eventos best-effort (D7) |
| `infrastructure/http/app.ts` | Modify | wiring `ListGigaredAccounts` con csRepo+catalogRepo (:2502); `TransferTvToCustomer` gana `gigaredTvActivationEventRepo` (:2518, D7) |
| `application/use-cases/gigared/splitCustomerName.ts` | Create | helper puro split APELLIDO-primero (D1 — **OPCIONAL**, batch B8) |

## Interfaces / Contracts

```ts
// D-pool — el listado del pool YA trae internalId; el filtrado es en memoria:
const clean = pool.filter(e => e.cic && (e.internalId === null || e.internalId === ''));

// D6 — errores nuevos (domain/errors/gigared.ts)
class TvPoolPoisonedError extends DomainError            // code TV_POOL_POISONED   → 422; { poisonedCount }
class TvIdentityStampUnverifiedError extends DomainError // code TV_IDENTITY_UNVERIFIED → 503; { cic, internalId }
class TvEmailOwnedByOtherError extends DomainError       // code TV_EMAIL_OWNED_BY_OTHER → 409; { email, ownedByInternalId }

// D3 — result de RegisterGigaredAccount.execute
{ account: GigaredAccount; partnerCreated: boolean; localReconciled: 'synced' | 'failed';
  credentialsPersisted: boolean; recovered: boolean }

// D4 — batch owner resolver (1 query, JOIN al Contract). El caller hace cicFromNotes exacto.
findActiveTvOwnersByCics(serviceCatalogId: string, cics: string[]): Promise<{ notes: string; clientId: string }[]>;

// D7 — TvEventType extendido
type TvEventType = 'alta' | 'baja' | 'reactivacion' | 'transferencia';

// D1 (OPCIONAL) — helper puro, split APELLIDO-primero
splitCustomerName(name: string | null | undefined): { firstName: string; lastName: string };
```

## FE Plan (repo ipnext-frontend, `GigaredPanel.tsx` — plan, NO código acá)

- **422** `TV_POOL_POISONED` → mensaje "No hay CICs limpios en el pool de Gigared; hace falta limpiar
  el pool" (accionable, no reintentar en loop). No hay CTA de auto-fix — es cleanup de datos.
- **503** `TV_IDENTITY_UNVERIFIED` → feedback "No se pudo verificar la identidad; reintentá" (el
  retry es idempotente por D2). Mismo patrón que un 503 transitorio.
- **409** `TV_EMAIL_OWNED_BY_OTHER` (o email-dup) → CTA "Vincular la cuenta existente" al flujo LINK.
- **207** en /register → "Cuenta creada; falta completar el vínculo local" + retry (idempotente).
- **`transferencia`** badge propio en el Historial TV (`ActivationHistoryModal`), distinto de
  alta/baja/reactivación (D7).
- **OPCIONAL (con D1/B8)**: inputs firstName/lastName → readonly, prefill del customer resuelto.
- Permisos: los del panel actual (`tv.write` / `tv.read` / `tv.link`), sin cambios.

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| UC pool-filter (D-pool) | fix #1 | fakePort: pool `[poisoned, clean]` → elige el clean (register recibe `clean.cic`); pool TODO envenenado → `TvPoolPoisonedError`, 0 register/activate/setInternalId; pool vacío → `NoCicAvailableError` |
| UC post-stamp (D-pool) | fix #1 | `getAccountByInternalId` post-stamp devuelve cic ≠ estampado → `TvIdentityStampUnverifiedError`, 0 reconcile local; readback 404 → propaga sin fila local |
| UC recovery (D2) | probe/catch | mine-stamped→sin pool/register/activate/setInternalId; 404→happy; orphan ''→resume; mine→local; other→`TvEmailOwnedByOtherError`; none→rethrow; `GigaredUnavailable`→propaga |
| UC idempotencia | D2 | 2º execute idéntico → 0 register, 0 double-charge, 0 consumo de CIC del pool |
| UC lista batch (D4) | mezcla con/sin fila local; spy: `findActiveTvOwnersByCics` UNA vez (no N+1); dirty 2 filas mismo cic→first-wins; sin deps→alias legacy |
| Route (D3/D6) | supertest: 207 si localReconciled failed, 201 full; `TV_POOL_POISONED`→422; `TV_IDENTITY_UNVERIFIED`→503; `TV_EMAIL_OWNED_BY_OTHER`→409 |
| Runner baja (D-baja) | fix #6 | `CancelTv.execute` devuelve `renew:{newCic}` → el evento `baja` incluye `renewCic:{newCic}` en `reason`; sin renew (`renew:null`) → `reason` legacy (solo el motivo del usuario) |
| UC transferencia (D7) | fresh+resume graban 2 eventos `transferencia`; fallo del repo NUNCA aborta; sin `activationEventRepo`→legacy byte-idéntico |
| Composition-root | app boota; ListGigaredAccounts + TransferTvToCustomer reciben las deps nuevas |
| Unit split (D1, OPCIONAL) | `splitCustomerName` | "VACHERAND SILVIO GABRIEL"→(last:VACHERAND, first:SILVIO GABRIEL); "CENTENO MIGUEL ANGEL"→(last:CENTENO); 1 token→ambos; vacío→fallback |

**Regla dura**: CERO writes reales al partner en TODO el suite (fakes/in-memory). El 1er ejercicio en
vivo lo aprueba el usuario (patrón K2 SmartOLT).

## Migration / Rollout

Aditivo, SIN flag (Decisión E). El shape 207 es superset de 201; sin migración de datos (el `newCic`
del D-baja va en el `reason`, columna existente). Rollback = revertir el change. Toca `app.ts`
(known_debt `god-object-app`). Handlers nuevos: `next(err)`/`sendGigaredError` SIEMPRE (lección 504).
**Alerta de despliegue**: si el pool ya está podrido (minas pre-fix), el fix #1 puede cortar altas
con `TV_POOL_POISONED` — medir cuántas minas hay en el smoke antes de confiar; limpiarlas manualmente
o vía el report (deuda) si hace falta.

## Open Questions

- [ ] D-baja: ¿el `renewCic:{cic}` en `reason` alcanza como breadcrumb, o el report de minas (deuda)
  justifica promoverlo a columna dedicada `recycledCic` en v2? (Hoy: reason-suffix, cero migración.)
- [ ] D1 (OPCIONAL): apellidos compuestos ("DE LA CRUZ …") → el split de un solo token captura sólo
  parte del apellido → email sub-óptimo pero determinístico. ¿Normalizar si el hardening entra, o v2?
- [ ] Deuda cardeada: report read-only de CICs envenenados del pool (reusa el filtro del D-pool).
  ¿Fast-follow tras validar el shape del filtro en prod?
