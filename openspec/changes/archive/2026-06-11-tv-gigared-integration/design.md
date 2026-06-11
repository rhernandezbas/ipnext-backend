# Design: TV Gigared Integration (#47)

## Technical Approach

Adapter `GigaredClient` (UispClient-style, X-API-Key) que lee la config de DB por request via `GigaredConfigRepository`; retry-429 espejo de `IClassClient.withAuthRetry` (IClassClient.ts:362-390) sin la rama 401-relogin. Use cases dependen de `GigaredPort` + ports existentes (#43: `ContractServiceRepository`, `ServiceCatalogRepository`). Router `/api/gigared` con guards `requirePerm('tv', …)` y middleware `requireGigaredReady` (flag + key) para todo salvo `/config`. FE: page CRM, tab cliente y tab settings, todo gateado por permisos `tv.*` y degradado por el 503 `GIGARED_NOT_CONFIGURED`.

## Architecture Decisions

| # | Decisión | Elección | Alternativa rechazada | Razón |
|---|----------|----------|----------------------|-------|
| D1 | Lectura de apiKey | **Por request**: `GigaredClient` recibe `configProvider: GigaredConfigRepository` y hace `get()` en cada llamada | Cache con invalidación al PUT config | Lookup PK single-row (~sub-ms) vs llamada HTTP externa (cientos de ms) — costo despreciable; cero bugs de invalidación; PUT toma efecto inmediato; multi-instancia safe. La invalidación acoplaría `UpdateGigaredConfig` a internals del adapter o pediría un event bus. |
| D2 | Guard not-configured | **Middleware `requireGigaredReady` del router** (flag ON + apiKey ≠ '') aplicado a todas las rutas EXCEPTO `/config`; defensa-en-profundidad: `GigaredClient` lanza `GigaredNotConfiguredError` si key vacía al momento de la llamada | Check en cada use case | Es un gate operativo cross-cutting, no regla de dominio: una sola definición, `/config` queda accesible para configurar (sine qua non), y supertest lo cubre en un solo seam. Repetirlo en 8 use cases es ruido. El throw del adapter cubre la carrera key-borrada-entre-middleware-y-llamada. |
| D3 | Migración | **UNA**: `20260630000000_gigared_tv` (tabla + módulo `tv` + grants + flag) | Dos (tabla / RBAC+flag) | Precedente `20260619000000_uisp_mirror` (una migración con tabla+RBAC+flag); las piezas son atómicamente inútiles por separado. Sin `BEGIN/COMMIT` (Prisma envuelve; patrón `20260629000000_iclass_node_catalog`). |
| D4 | Flag en el DTO de config | `enabled` viaja en GET/PUT `/api/gigared/config` (lee/escribe `FeatureFlag 'gigared-integration'` via `FeatureFlagRepository`) | FE usa `/api/admin/feature-flags` | Ese endpoint exige `admin.flags` (app.ts:1507); el operador de config TV tiene `tv.manage`, no necesariamente `admin.flags`. El tab queda self-contained. |
| D5 | Identidad en mutaciones | `addService/removeService/setOtt/getAccount` siempre por `internal_id = String(customer.id)` con `use_internal_id=true`; el CIC solo se usa en link/register | Pasar CIC desde FE | El binding vive en Gigared (proposal); no persistimos CIC; evita desync FE↔Gigared. |
| D6 | Slot local TV | Tras CADA mutación de servicios, **reconcile**: `getAccountByInternalId` → si tiene servicios, upsert `ContractService` (catálogo resuelto por `getByName('TV')`, guard `TvCatalogMissingError` → 422) con `notes = "CIC {cic} · {names.join(' · ')}"`; si quedó vacío, delete idempotente | Add/remove ciego del row local | El par (contractId, serviceCatalogId) es UNIQUE: el 2º servicio Gigared rompería con duplicate. Reconcile es determinista y hace el retry manual trivial. |
| D7 | 207 y retry | Gigared OK + reconcile falla → **207** `{ code: 'TV_LOCAL_SYNC_FAILED' }`. Retry manual = re-POST del mismo endpoint: si Gigared rechaza el add y la cuenta YA tiene el serviceId, se trata como éxito y se sigue al reconcile (idempotencia) | Endpoint /reconcile dedicado | Sin transacción distribuida (proposal); re-POST seguro evita superficie API extra. |
| D8 | Test de conexión FE | Botón "Probar conexión" llama `GET /api/gigared/summary` | `GET /health/live` | health/live no requiere auth (tv.md) — no valida la key. Summary valida key + devuelve datos útiles (cuentas/servicios) para el propio tab. |

## Wire Contract (VERBATIM — los applies construyen contra esto)

Router montado: `app.use('/api/gigared', createAuthMiddleware(authAdapter, sessionRepo), createGigaredRouter(...))` (patrón uisp, app.ts:1645). Orden interno: `/config` (GET/PUT, `requirePerm('tv','manage')`) → `router.use(requireGigaredReady)` → resto.

```
GET    /api/gigared/config                                  tv.manage → 200 GigaredConfigDTO
PUT    /api/gigared/config                                  tv.manage → 200 GigaredConfigDTO | 400 VALIDATION_ERROR
GET    /api/gigared/summary                                 tv.read   → 200 GigaredSummary
GET    /api/gigared/accounts?email&status&account_id
         &pagination_limit&pagination_offset                tv.read   → 200 { accounts: GigaredAccount[] }
GET    /api/gigared/customers/:id/account                   tv.read   → 200 { linked: boolean, account: GigaredAccount | null }
POST   /api/gigared/customers/:id/link      { cic }         tv.write  → 200 { account: GigaredAccount }
POST   /api/gigared/customers/:id/register  { firstName, lastName, email, cic,
         password, sendActivationEmail }                    tv.write  → 201 { account: GigaredAccount }
POST   /api/gigared/customers/:id/services  { serviceId, contractId }
                                                            tv.write  → 200 AddTvServiceResult | 207 AddTvServiceResult
DELETE /api/gigared/customers/:id/services/:serviceId?contractId=…
                                                            tv.write  → 200 RemoveTvServiceResult | 207 …
PUT    /api/gigared/customers/:id/ott       { enabled }     tv.write  → 200 { ok: true }

Errores (body { error, code }):
  503 GIGARED_NOT_CONFIGURED   flag OFF o apiKey vacía (middleware) — el FE muestra banner accionable
  503 GIGARED_UNAVAILABLE      red/5xx/429 agotado
  502 GIGARED_AUTH_FAILED      401/403 de Gigared (key inválida)
  404 GIGARED_NOT_FOUND        cuenta/CIC inexistente en Gigared
  404 CUSTOMER_NOT_FOUND       :id no existe en nuestra DB
  404 CONTRACT_NOT_FOUND       contractId inválido (add/remove service)
  422 GIGARED_REJECTED         RFC 9457 4xx restante (title/detail en error)
  422 TV_CATALOG_MISSING       ServiceCatalog sin entrada activa 'TV'
  400 VALIDATION_ERROR         Zod safeParse (convención repo)
```

```ts
// DTOs (application/dto/gigared.dto.ts — Zod + tipos)
interface GigaredConfigDTO { configured: boolean; apiKeyLast4: string | null; baseUrl: string; enabled: boolean; updatedAt: string }
// PUT body (Zod): { apiKey?: string; baseUrl?: string /* url */; enabled?: boolean } — apiKey omitida = sin cambio; '' = borrar key. La key completa JAMÁS sale en respuestas.
interface AddTvServiceResult { gigared: 'ok'; local: 'ok' | 'failed'; contractServiceId?: string; localError?: string }
```

## Interfaces / Contracts (domain)

```ts
// src/domain/ports/GigaredPort.ts — shapes camelCase; snake_case vive SOLO dentro de GigaredClient
export interface GigaredService { id: string; name: string }
export interface GigaredOtt { id: string; stationaryLicenses: number; mobileLicenses: number; registeredDevices: number; status: string | null }
export interface GigaredAccount {
  cic: string; gigaredId: string | null; email: string | null; firstName: string | null;
  lastName: string | null; registrationDate: string | null; services: GigaredService[];
  internalId: string | null; ott: GigaredOtt | null;
}
export interface GigaredPartnerService extends GigaredService { qtyAvailable: number; qtyUsed: number; qtyPurchased: number }
export interface GigaredSummary { accounts: { registered: number; unregistered: number; total: number }; services: GigaredPartnerService[] }
export interface ListAccountsFilter { accountId?: string; useInternalId?: boolean; email?: string; status?: 'registered' | 'unregistered'; paginationLimit?: number; paginationOffset?: number }

export interface GigaredPort {
  getSummary(): Promise<GigaredSummary>;
  listAccounts(filter?: ListAccountsFilter): Promise<GigaredAccount[]>;
  getAccountByInternalId(internalId: string): Promise<GigaredAccount>; // throws GigaredNotFoundError
  register(input: { firstName: string; lastName: string; email: string; cic: string; password: string; sendActivationEmail: boolean }): Promise<void>;
  activate(input: { cic: string; email: string }): Promise<void>;
  setInternalId(cic: string, internalId: string): Promise<void>;
  addService(internalId: string, serviceId: string): Promise<void>;
  removeService(internalId: string, serviceId: string): Promise<void>;
  setOtt(internalId: string, enabled: boolean): Promise<void>;
}

// src/domain/ports/GigaredConfigRepository.ts — patrón GestionRealSyncConfigRepository.ts (get/update, defaults sin row)
export interface GigaredConfig { apiKey: string; baseUrl: string; updatedAt: string }
export interface GigaredConfigRepository { get(): Promise<GigaredConfig>; update(patch: Partial<Pick<GigaredConfig, 'apiKey' | 'baseUrl'>>): Promise<GigaredConfig> }

// src/domain/errors/gigared.ts
GigaredNotConfiguredError | GigaredUnavailableError | GigaredAuthError | GigaredNotFoundError | GigaredRejectedError(title, detail) | TvCatalogMissingError
```

**Adapter** (`src/infrastructure/adapters/gigared/GigaredClient.ts`): `constructor(opts: { configProvider: GigaredConfigRepository; timeoutMs?: number; http?: AxiosInstance; maxRateLimitRetries?: number; backoffMs?: number })`. Axios sin `baseURL` fijo (la baseUrl puede cambiar por config): cada request usa `${cfg.baseUrl}${path}` + header `{ 'X-API-Key': cfg.apiKey }`. `withRetry429<T>(fn)` = copia de IClassClient.ts:362-390 **sin** la rama 401 (`parseRetryAfterMs(e) ?? backoffMs * 2**attempt`, máx 4 reintentos, luego `mapError`). `mapError`: 401/403→`GigaredAuthError`; 404→`GigaredNotFoundError`; otros 4xx con body RFC 9457→`GigaredRejectedError(title, detail)`; red/5xx/429 agotado→`GigaredUnavailableError`. Nunca filtra axios cross-layer (precedente IClass).

**Mapeo Gigared→HTTP de errores Gigared** en el router (catch tipado por instancia, patrón uisp.routes.ts:52).

## Use Cases (firmas exactas — `src/application/use-cases/gigared/`)

`CustomerLookup`/`ContractLookup` = interfaces existence-only inyectadas (precedente `AddContractService.ContractLookup`; wiring: `{ findById: (id) => prismaClientLookup('Client'|'Contract', id) }`, app.ts:561).

| Use case | Constructor | execute |
|---|---|---|
| `GetGigaredConfig` | `(configRepo, flagRepo: FeatureFlagRepository)` | `(): Promise<GigaredConfigDTO>` — masking acá: `configured = apiKey !== ''`, `apiKeyLast4 = apiKey.slice(-4) \|\| null` |
| `UpdateGigaredConfig` | `(configRepo, flagRepo)` | `(patch: { apiKey?; baseUrl?; enabled? }): Promise<GigaredConfigDTO>` — `enabled` → `flagRepo.setEnabled('gigared-integration', …)` |
| `GetGigaredSummary` | `(gigared: GigaredPort)` | `(): Promise<GigaredSummary>` |
| `ListGigaredAccounts` | `(gigared)` | `(filter: ListAccountsFilter): Promise<{ accounts: GigaredAccount[] }>` |
| `GetGigaredCustomerAccount` | `(gigared, customerLookup)` | `(customerId): Promise<{ linked: boolean; account: GigaredAccount \| null }>` — `GigaredNotFoundError` → `{ linked: false, account: null }` (no propaga) |
| `LinkCustomerToCic` | `(gigared, customerLookup)` | `(customerId, cic): Promise<{ account }>` — `setInternalId(cic, customerId)` → `getAccountByInternalId(customerId)` |
| `RegisterGigaredAccount` | `(gigared, customerLookup)` | `(customerId, input): Promise<{ account }>` — `register` → `activate({ cic, email })` → `setInternalId` → `getAccountByInternalId`. Password transit-only, NO se persiste ni loguea |
| `AddTvService` | `(gigared, csRepo: ContractServiceRepository, catalogRepo: ServiceCatalogRepository, contractLookup, customerLookup)` | `(customerId, { contractId, serviceId }): Promise<AddTvServiceResult>` — guards: customer 404 → contract 404 → catálogo `getByName('TV')` activo (422) → `gigared.addService` (si `GigaredRejectedError` y la cuenta YA tiene serviceId → continuar, D7) → reconcile (D6); reconcile falla → `local: 'failed'` (207) |
| `RemoveTvService` | mismas deps | `(customerId, { contractId, serviceId })` — espejo: `removeService` → reconcile (lista vacía → delete local) |
| `SetOttStatus` | `(gigared, customerLookup)` | `(customerId, enabled: boolean): Promise<void>` |

El reconcile compartido vive en `src/application/use-cases/gigared/reconcileTvContractService.ts` (función pura sobre los ports, usada por Add/Remove).

## Data Flow (activación TV)

    TvTab ──POST /customers/:id/services──▶ gigared.routes ──▶ AddTvService
                                                │ guards (lookups + catálogo 'TV')
                                                ├─▶ GigaredPort.addService(internalId, serviceId)   [1º Gigared]
                                                └─▶ reconcile: getAccountByInternalId ──▶ csRepo.add/update(notes "CIC … · …")  [2º local]
                                                      └─ falla → 207 TV_LOCAL_SYNC_FAILED (retry = re-POST, idempotente)

## DB / Migración (`prisma/migrations/20260630000000_gigared_tv/migration.sql`)

```prisma
model GigaredConfig {
  id        String   @id @default("singleton")
  apiKey    String   @default("")
  baseUrl   String   @default("https://partners.gigaredsa.com.ar/api/v1")
  updatedAt DateTime @updatedAt
}
```

SQL (sin BEGIN/COMMIT, todo idempotente `ON CONFLICT DO NOTHING`, patrón uisp_mirror secciones RBAC): `CREATE TABLE "GigaredConfig"`; INSERT `RbacModule ('tv','TV / Gigared')`; INSERT `RbacPermission` read/write/manage; grants de los 3 a `super_admin` **y** `administrador` (proposal; uisp solo granteó super_admin — acá son dos roles); INSERT `FeatureFlag ('gigared-integration', false)`. Además: agregar `'tv'` a `RBAC_MODULES` en `src/domain/entities/rbac.ts:74` (union tipada — sin esto `requirePerm('tv', …)` no compila); read/write/manage ya existen en `KNOWN_ACTIONS`.

## File Changes

**Backend** (nuevos salvo indicado):
| File | Acción |
|------|--------|
| `src/domain/ports/GigaredPort.ts`, `src/domain/ports/GigaredConfigRepository.ts`, `src/domain/errors/gigared.ts` | Create |
| `src/domain/entities/rbac.ts` | Modify — `'tv'` en `RBAC_MODULES` |
| `src/infrastructure/adapters/gigared/GigaredClient.ts` | Create |
| `src/infrastructure/adapters/prisma/PrismaGigaredConfigRepository.ts` (patrón `PrismaGestionRealSyncConfigRepository`: SINGLETON_ID, DEFAULTS, upsert, accessor `(prisma as any)`) + `src/infrastructure/adapters/in-memory/InMemoryGigaredConfigRepository.ts` (paridad) | Create |
| `src/application/dto/gigared.dto.ts` + `src/application/use-cases/gigared/*.ts` (10 + reconcile) | Create |
| `src/infrastructure/http/routes/gigared.routes.ts` (router + `createGigaredReadyMiddleware(configRepo, flagRepo)` exportado del mismo archivo — un solo seam) | Create |
| `src/infrastructure/http/app.ts` | Modify — wiring (abajo) |
| `prisma/schema.prisma` + migración | Modify/Create |

Wiring app.ts (junto al bloque uisp, reusando `featureFlagRepo` (app.ts:762), `serviceCatalogRepo` (app.ts:1067) y el `PrismaContractServiceRepository` ya construido para #43):
```ts
const gigaredConfigRepo = new PrismaGigaredConfigRepository();
const gigaredClient = new GigaredClient({ configProvider: gigaredConfigRepo });
app.use('/api/gigared', createAuthMiddleware(authAdapter, sessionRepo), createGigaredRouter({
  getConfig, updateConfig, getSummary, listAccounts, getCustomerAccount, linkCustomerToCic,
  registerAccount, addTvService, removeTvService, setOttStatus,           // use cases
  requireRead: requirePerm('tv','read'), requireWrite: requirePerm('tv','write'), requireManage: requirePerm('tv','manage'),
  gigaredReady: createGigaredReadyMiddleware(gigaredConfigRepo, featureFlagRepo),
}));
```

**Frontend** (repo ipnext-frontend, sobre origin/main que incluye #40-#46):
| File | Acción |
|------|--------|
| `src/types/gigared.ts`, `src/api/gigared.api.ts` (BASE `/gigared`), `src/hooks/useGigared.ts` | Create |
| `src/pages/crm/GigaredAccountsPage.tsx` + `.module.css` | Create |
| `src/pages/customers/tabs/TvTab.tsx` + `.module.css` | Create |
| `src/pages/customers/settings/GigaredTvBody.tsx` + `.module.css` | Create |
| `src/components/molecules/GigaredNotConfigured/GigaredNotConfigured.tsx` + `.module.css` (banner compartido page+tab) | Create |
| `src/App.tsx` | Modify — en bloque CRM (línea ~307): `<Route path="tv" element={<RequirePermission permission="tv.read"><GigaredAccountsPage /></RequirePermission>} />` + lazy import |
| `src/components/organisms/Sidebar/Sidebar.tsx` | Modify — `CRM_ITEMS` → sección "Clientes potenciales" (matchPaths `/admin/crm`): child `{ to: '/admin/crm/tv', label: 'TV', requiredPermission: 'tv.read' }` (precedente per-child: 'Contratos' con `contracts.read`) |
| `src/pages/customers/CustomerDetailPage.tsx` | Modify — `'tv'` en `TAB_IDS` (línea 23) + tab `{ id: 'tv', label: 'TV', content: <TvTab customerId={id} /> }` condicionado `useCan('tv.read')`; lazy via `activatedTabs` existente |
| `src/pages/customers/CustomersSettingsPage.tsx` | Modify — tab `{ id: 'gigared', label: 'Gigared TV', content: <GigaredTvBody /> }` gateado `can('tv.manage')` (patrón tab `servicios`/`clients.manage`) |

FE detalles de diseño (registro **product**, CSS Modules + tokens existentes, sin nuevos tokens):
- **GigaredAccountsPage**: header con breadcrumb "CRM / TV"; franja superior con el summary del partner: conteos registered/unregistered/total inline + tabla compacta de servicios del partner (name · qty_available/qty_purchased) — NO card-grid de métricas. Tabla principal paginada server-side (`pagination_limit/offset`, default 25): CIC, Nombre, Email, Servicios (chips de texto), OTT (estado). Filtros: input email (debounce 400ms) + select status. Estados: loading skeleton de filas, vacío ("Sin cuentas para el filtro"), error 503 NOT_CONFIGURED → `GigaredNotConfigured` (link a `/admin/customers/settings#gigared` si `can('tv.manage')`, si no texto "pedile a un administrador"), error 503 UNAVAILABLE → notice con botón Reintentar (refetch).
- **TvTab**: tres estados. (1) 503 NOT_CONFIGURED → banner. (2) `linked: false` → empty state con dos acciones inline (sin modal-first): form "Vincular cuenta existente" (input CIC + submit) y form colapsable "Registrar cuenta nueva" (firstName/lastName/email/cic/password/sendActivationEmail; password `type="password"`, no se guarda en estado tras submit). (3) `linked: true` → datos cuenta (CIC, email, nombre, fecha registro), lista de servicios con botón quitar (ConfirmModal existente), agregar servicio: select de servicios del partner (de summary, deshabilitando `qtyAvailable === 0`) + **selector de contrato** (de `useClientContracts(id)` ya mockeable) + submit; toggle OTT con estado `ott.status`. Respuesta 207 → notice ámbar persistente "Servicio activado en Gigared; falló el registro local — Reintentar" (re-POST).
- **GigaredTvBody**: filas tipo formulario (patrón GestionRealSyncBody): estado key (`configured` + `···{last4}` o "Sin configurar"), input `type="password"` para nueva key (solo se envía si no vacío) + Guardar; toggle "Integración activa" (`enabled`); botón "Probar conexión" → `getSummary()` → inline ok (cuentas/servicios) o error mapeado (502 AUTH_FAILED → "API key inválida").
- **Hooks/invalidaciones** (`useGigared.ts`): keys `['gigared','config']`, `['gigared','summary']`, `['gigared','accounts',filters]`, `['gigared','account',customerId]`. Mutaciones: link/register invalidan `['gigared','account',customerId]` + `['gigared','summary']` + `['gigared','accounts']`; add/removeService además `['client-contracts', clientId]` (key real de ContractsTab, useContractServices.ts:16); setOtt invalida `['gigared','account',customerId]`; updateConfig invalida `['gigared','config']` y `['gigared','summary']`.

## Testing Strategy (STRICT TDD — red → green → refactor por pieza)

| Pieza | Tests (fixtures = shapes VERBATIM de tv.md pineados) |
|---|---|
| `GigaredClient` | axios inyectado mock: header `X-API-Key` exacto; URLs/query exactos (`use_internal_id=true`, `service_id`); mapeo snake→camel con fixture de `/accounts` y detalle con nulls; 429 con `Retry-After` → retry → éxito; 429×5 → `GigaredUnavailableError`; 401/403 → `GigaredAuthError`; 404 → NotFound; RFC 9457 400 → `GigaredRejectedError(title, detail)`; config leída POR LLAMADA (cambiar key del provider entre llamadas sin re-instanciar); key vacía → `GigaredNotConfiguredError` sin tocar axios |
| Config repo | `InMemoryGigaredConfigRepository`: defaults sin row, update parcial, paridad de contrato con Prisma (suite compartida estilo GR sync) |
| Use cases | `InMemory*` + fake `GigaredPort` (jest.fn por método). `AddTvService`: happy (notes `"CIC 0000000001 · Gigared Play Full"`), 2º servicio → update notes (no duplicate), rejected-pero-ya-asignado → continúa, reconcile falla → `local:'failed'`, catálogo TV ausente/inactivo → `TvCatalogMissingError`, contract/customer 404. `RemoveTvService`: último servicio → delete local. `GetGigaredCustomerAccount`: NotFound → `{linked:false}`. `RegisterGigaredAccount`: orden register→activate→setInternalId. Config: masking (`configured`, last4, key completa ausente) |
| Routes (seam, supertest + in-memory) | 503 `GIGARED_NOT_CONFIGURED` con flag OFF y con key vacía (todo el surface salvo /config); `/config` accesible sin key; GET config: el body serializado NO contiene la key completa (assert `!body.includes(key)`); 403 sin grant por verbo (tv.read/write/manage); 207 scenario end-to-end (gigared fake ok + csRepo que falla); mapeo de cada error de dominio al status pineado; orden de rutas |
| Composition root | `src/__tests__/infrastructure/gigared-composition.test.ts` (patrón estático contract-services-composition.test.ts): (a) `createGigaredRouter(` con `requirePerm`; (b) mount `'/api/gigared'`; (c) `new GigaredClient(` con `gigaredConfigRepo`; (d) `new AddTvService(` con repo de contract services |
| FE api | wire test mock de `@/api/axios-client` (patrón gestionRealIngest.api.test.ts): URLs/métodos/params exactos del wire contract |
| FE componentes | `vi.mock('@/hooks/useMyPermissions')` para gates (lección #41 — jamás fetch real de permisos); GigaredAccountsPage: filas+filtros, banner 503, paginación; TvTab: 3 estados + 207 notice + selector contrato; GigaredTvBody: masking visual, save solo-si-cambia, probar conexión ok/auth-failed; CustomersSettingsPage/CustomerDetailPage/Sidebar: visibilidad gateada por `tv.manage`/`tv.read` |

## Migration / Rollout

1. **Deploy BE primero** (PR backend): migración + código con flag OFF y key vacía → TODO inerte: `/api/gigared/*` (salvo config) devuelve 503; cero llamadas salientes. Deploy seguro sin el token.
2. **Deploy FE**: superficies visibles solo con permisos `tv.*` (hoy: super_admin + administrador por migración); muestran banner not-configured.
3. **Post-deploy** (cuando llegue la key del Ejecutivo de Cuentas): Settings → Clientes → Gigared TV → pegar key → Probar conexión → toggle "Integración activa" (= flag ON) → smoke en `/admin/crm/tv` → asignar `tv.*` a roles adicionales via UI de roles si aplica.
4. **Rollback**: toggle OFF = kill switch (503 + banners); revert por PR; migración aditiva queda inerte.

## Open Questions

Ninguna bloqueante. Nota V1 documentada: key en texto plano en DB (mitigada por masking en API; pgcrypto es V2 — proposal).
