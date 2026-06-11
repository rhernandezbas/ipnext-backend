# Tasks: TV Gigared Integration (#47)

> Wire contract VERBATIM: 10 rutas · GIGARED_NOT_CONFIGURED 503 · TV_NOT_LINKED 404 · CIC_NOT_FOUND/CIC_ALREADY_LINKED · TV_LOCAL_SYNC_FAILED 207

---

## Phase 1 — Foundation (DB + Domain)

- [x] 1.1 [RED] `prisma/migrations/20260630000000_gigared_tv/migration.sql` — tabla GigaredConfig + RbacModule `tv` + 3 RbacPermissions + grants super_admin Y administrador + FeatureFlag `gigared-integration=false`; sin BEGIN/COMMIT
- [x] 1.2 [GREEN] `prisma/schema.prisma` — model GigaredConfig con id/apiKey/baseUrl/updatedAt
- [x] 1.3 [RED→GREEN] `src/domain/entities/rbac.ts:74` — agregar `'tv'` a RBAC_MODULES union
- [x] 1.4 [RED→GREEN] `src/domain/errors/gigared.ts` — 6 clases: GigaredNotConfiguredError · GigaredUnavailableError · GigaredAuthError · GigaredNotFoundError · GigaredRejectedError(title,detail) · TvCatalogMissingError
- [x] 1.5 [RED→GREEN] `src/domain/ports/GigaredPort.ts` — interface GigaredPort + GigaredAccount/GigaredSummary/GigaredPartnerService/ListAccountsFilter (shapes camelCase VERBATIM design)
- [x] 1.6 [RED→GREEN] `src/domain/ports/GigaredConfigRepository.ts` — interface GigaredConfig + GigaredConfigRepository (get/update)
- [x] 1.7 [RED→GREEN] `src/application/dto/gigared.dto.ts` — GigaredConfigDTO + AddTvServiceResult + Zod schemas PUT body

## Phase 2 — Infrastructure Adapters

- [x] 2.1 [RED] Test `InMemoryGigaredConfigRepository`: defaults sin row, update parcial (paridad contrato con Prisma)
- [x] 2.2 [GREEN] `src/infrastructure/adapters/in-memory/InMemoryGigaredConfigRepository.ts`
- [x] 2.3 [RED] Tests GigaredClient: header X-API-Key exacto; config leída por llamada; key vacía→NotConfiguredError sin tocar axios; 429+Retry-After→retry→éxito; 429×5→UnavailableError; 401→AuthError; 404→NotFoundError; RFC-9457 4xx→RejectedError(title,detail)
- [x] 2.4 [GREEN] `src/infrastructure/adapters/gigared/GigaredClient.ts` — constructor(opts: {configProvider, timeoutMs?, http?, maxRateLimitRetries?, backoffMs?}); withRetry429 espejo IClassClient.ts:362-390 SIN rama 401; mapError tipado
- [x] 2.5 [GREEN] `src/infrastructure/adapters/prisma/PrismaGigaredConfigRepository.ts` — patrón PrismaGestionRealSyncConfigRepository: SINGLETON_ID, DEFAULTS, upsert, accessor `(prisma as any)`

## Phase 3 — Use Cases (TDD estricto)

- [x] 3.1 [RED→GREEN] `GetGigaredConfig` — masking: configured, apiKeyLast4, key completa ausente; spec escenario key='' y key='abcdef1234'
- [x] 3.2 [RED→GREEN] `UpdateGigaredConfig` — enabled→flagRepo.setEnabled('gigared-integration'); patch parcial
- [x] 3.3 [RED→GREEN] `GetGigaredSummary`, `ListGigaredAccounts`, `GetGigaredCustomerAccount` (NotFound→{linked:false,account:null})
- [x] 3.4 [RED→GREEN] `LinkCustomerToCic` — setInternalId→getAccountByInternalId; CIC_NOT_FOUND; CIC_ALREADY_LINKED
- [x] 3.5 [RED→GREEN] `RegisterGigaredAccount` — orden register→activate→setInternalId; password transit-only NO persiste
- [x] 3.6 [RED] Tests AddTvService: happy (notes "CIC 0000000001 · Gigared Play Full"); 2º servicio→update notes; rejected-ya-asignado→continúa (D7); reconcile falla→local:'failed' 207; catálogo TV ausente→TvCatalogMissingError; contract/customer 404
- [x] 3.7 [GREEN] `src/application/use-cases/gigared/reconcileTvContractService.ts` — función pura (ports); upsert notes "CIC {cic} · {names}"; lista vacía→delete idempotente
- [x] 3.8 [GREEN] `AddTvService.ts` + `RemoveTvService.ts` usando reconcile
- [x] 3.9 [RED→GREEN] `SetOttStatus` — enable/disable; TV_NOT_LINKED propagado

## Phase 4 — HTTP Router + Seam Tests

- [x] 4.1 [RED] Seam tests (supertest + in-memory): 503 GIGARED_NOT_CONFIGURED con flag OFF; 503 con key=''; /config accesible sin key; GET config body NO contiene key completa; 403 por verbo (tv.read/write/manage); 207 end-to-end (gigared fake ok + csRepo falla); mapeo cada error de dominio al status pineado
- [x] 4.2 [GREEN] `src/infrastructure/http/routes/gigared.routes.ts` — createGigaredRouter + createGigaredReadyMiddleware exportados; orden: /config→router.use(requireGigaredReady)→resto; catch tipado por instancia (patrón uisp.routes.ts:52)
- [x] 4.3 [RED→GREEN] `src/infrastructure/http/app.ts` — wiring junto al bloque uisp: PrismaGigaredConfigRepository + GigaredClient + 10 use cases + createAuthMiddleware + createGigaredRouter montado en `/api/gigared`
- [x] 4.4 [RED→GREEN] `src/__tests__/infrastructure/gigared-composition.test.ts` — 4 asserts estáticos: createGigaredRouter llamado con requirePerm; mount '/api/gigared'; new GigaredClient con gigaredConfigRepo; new AddTvService con contractServiceRepo

## Phase 5 — Frontend (repo ipnext-frontend)

- [x] 5.1 `src/types/gigared.ts` — interfaces VERBATIM del wire contract
- [x] 5.2 `src/api/gigared.api.ts` — 10 funciones; BASE `/gigared`; wire test mock axios-client (patrón gestionRealIngest.api.test.ts)
- [x] 5.3 `src/hooks/useGigared.ts` — query keys: ['gigared','config']/['gigared','summary']/['gigared','accounts',filters]/['gigared','account',customerId]; invalidaciones post-mutación (add/remove invalidan además ['client-contracts',clientId])
- [x] 5.4 `src/components/molecules/GigaredNotConfigured/GigaredNotConfigured.tsx` — banner compartido; link a settings si can('tv.manage')
- [x] 5.5 `src/pages/crm/GigaredAccountsPage.tsx` — franja summary + tabla paginada server-side (CIC/Nombre/Email/Servicios/OTT); filtros email+status; 503 NOT_CONFIGURED→banner; vi.mock useMyPermissions; test filas+filtros+paginación+estados error
- [x] 5.6 `src/pages/customers/tabs/TvTab.tsx` — 3 estados: NOT_CONFIGURED banner / not-linked (form vincular + form registrar colapsable) / linked (servicios+OTT+selector contrato); 207→notice ámbar; test 3 estados + 207 notice + selector contrato
- [x] 5.7 `src/pages/customers/settings/GigaredTvBody.tsx` — input password nueva key; toggle enabled; botón Probar conexión→getSummary(); test masking visual + save solo-si-cambia + probar-conexión ok/auth-failed
- [x] 5.8 `src/App.tsx` — Route `tv` bajo CRM con RequirePermission `tv.read` + lazy import GigaredAccountsPage
- [x] 5.9 `src/components/organisms/Sidebar/Sidebar.tsx` — child `{ to: '/admin/crm/tv', label: 'TV', requiredPermission: 'tv.read' }` en CRM_ITEMS
- [x] 5.10 `src/pages/customers/CustomerDetailPage.tsx` — `'tv'` en TAB_IDS; tab TvTab condicionado useCan('tv.read'); test visibilidad gateada
- [x] 5.11 `src/pages/customers/CustomersSettingsPage.tsx` — tab `{ id: 'gigared', label: 'Gigared TV', content: <GigaredTvBody /> }` gateado can('tv.manage'); test visibilidad

## Phase 6 — Gates Orquestador

- [ ] 6.1 BE: ejecutar `npm test -- --runInBand`; 0 failures; confirmar snapshot migration test pasa
- [ ] 6.2 FE: ejecutar `vitest run`; 0 failures; confirmar wire boundary tests pasan
- [ ] 6.3 Smoke deploy check: flag OFF → todo `/api/gigared/*` salvo /config devuelve 503; toggle ON → summary ok
