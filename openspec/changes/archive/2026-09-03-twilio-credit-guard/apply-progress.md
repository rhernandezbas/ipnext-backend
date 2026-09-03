# Apply Progress — twilio-credit-guard

**Repo**: ipnext-backend · **Worktree**: `.claude\worktrees\twilio-credit-guard-be` · **Branch**: `feat/twilio-credit-guard`
**Mode**: Strict TDD (RED → GREEN, adapters in-memory, JAMÁS Prisma real / axios real)

## Batch B1 — Schema + dominio + ports + adapters in-memory/Prisma + gateway Twilio (D1-D3)

Status: **COMPLETE** — 9/9 tasks + Gate B1.

- [x] 1.1 Migración `prisma/migrations/20261113000000_messaging_rates_config/migration.sql` generada sin DB (`prisma migrate diff --from-schema <before> --to-schema prisma/schema.prisma --script`), sin `BEGIN`/`COMMIT`.
- [x] 1.2 `prisma/schema.prisma`: modelo `MessagingRatesConfig` (singleton, 4 `Decimal(10,4)` + `currency` + `updatedAt`) pegado a `ExternalBulkMessagingConfig`; `ExternalBulkPreview.credit Json?` agregado. `npx prisma generate` limpio desde este worktree.
- [x] 1.3 `src/domain/services/fixedPointMoney.ts` (NEW, puro) + `src/__tests__/domain/fixedPointMoney.test.ts` — 38 tests: parseMoney/tryParseMoney/addMoney/multiplyMoneyByCount/compareMoney/formatMoney, half-up, round-trip, rechazo de inputs no confiables, `Number.isSafeInteger`.
- [x] 1.4 `src/domain/errors/external-bulk-messaging.ts` (MOD): `InsufficientCreditError` (422 `INSUFFICIENT_CREDIT`) + `CreditUnavailableError` (503 `CREDIT_UNAVAILABLE`). `errorHandler.ts` statusMap: 2 entradas nuevas junto a `REPORTER_UNAVAILABLE`.
- [x] 1.5 `src/domain/ports/CreditBalancePort.ts` (NEW) + `src/domain/ports/MessagingRatesConfigRepository.ts` (NEW, con `MESSAGING_RATES_CONFIG_DEFAULTS`).
- [x] 1.6 `InMemoryCreditBalancePort.ts` + `InMemoryMessagingRatesConfigRepository.ts` (NEW) + 8 tests combinados (5 + 3).
- [x] 1.7 `PrismaMessagingRatesConfigRepository.ts` (NEW, clon 1:1, fix F14 — lazy upsert, sin `updatedAt` fabricado) + 4 tests (mocked-Prisma pattern, Decimal↔string en la frontera).
- [x] 1.8/1.9 `TwilioCreditBalanceGateway.ts` (NEW, clase propia, axios propio) + `src/__tests__/infrastructure/TwilioCreditBalanceGateway.test.ts` — 17 tests: parseo body real, URL+Basic auth exactos, TODO error→`CreditUnavailableError` (401/403/404/429/500/timeout/red/JSON basura/balance ilegible/currency vacía), cache single-slot TTL 60s con reloj inyectable (hit, miss por vencimiento), error NO cacheado.
- [x] Gate B1: `npx prisma generate` limpio; `npx tsc --noEmit` limpio; suites nuevas verdes; suite completa del repo verde.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1.3 | `src/__tests__/domain/fixedPointMoney.test.ts` | Unit | N/A (new) | ✅ Written | ✅ 38/38 | ✅ half-up, negativos, round-trip, rechazos, borde safe-integer | ✅ Clean |
| 1.6 | `.../InMemoryCreditBalancePort.test.ts` | Unit | N/A (new) | ✅ Written | ✅ 5/5 | ✅ defaults + settable + failNext + calls | ➖ None needed |
| 1.6 | `.../InMemoryMessagingRatesConfigRepository.test.ts` | Unit | N/A (new) | ✅ Written | ✅ 3/3 | ✅ defaults + set/get + sucesivos | ➖ None needed |
| 1.7 | `.../PrismaMessagingRatesConfigRepository.test.ts` | Unit (mocked-Prisma) | N/A (new) | ✅ Written | ✅ 4/4 | ✅ lazy-create, degradación DB read-only, mapeo Decimal, set() strings | ➖ None needed |
| 1.8/1.9 | `.../TwilioCreditBalanceGateway.test.ts` | Unit (fake AxiosInstance) | N/A (new) | ✅ Written | ✅ 17/17 | ✅ parseo, URL/auth, 5 status codes + timeout + red + JSON basura + balance/currency inválidos, cache hit/miss/no-cachea-error | ✅ Clean |

### Test Summary
- **Total tests escritos en B1**: 67 (38 + 5 + 3 + 4 + 17)
- **Total tests pasando (suites de B1)**: 67/67
- **Suite COMPLETA del repo** (`npm test`, post-B1): `Test Suites: 6 skipped, 1259 passed, 1259 of 1265 total` · `Tests: 88 skipped, 13125 passed, 13213 total` · exit code 0. Sin regresiones.
- **`npx tsc --noEmit`**: limpio, sin output.
- **Layers usadas**: Unit (67), Integration (0), E2E (0).
- **Pure functions creadas**: `fixedPointMoney.ts` (6 funciones puras: parseMoney, tryParseMoney, addMoney, multiplyMoneyByCount, compareMoney, formatMoney).

## Archivos tocados en B1

| Archivo | Acción |
|---|---|
| `prisma/schema.prisma` | MOD — `MessagingRatesConfig` + `ExternalBulkPreview.credit` |
| `prisma/migrations/20261113000000_messaging_rates_config/migration.sql` | NEW |
| `src/domain/services/fixedPointMoney.ts` | NEW |
| `src/__tests__/domain/fixedPointMoney.test.ts` | NEW |
| `src/domain/errors/external-bulk-messaging.ts` | MOD |
| `src/infrastructure/http/middleware/errorHandler.ts` | MOD |
| `src/domain/ports/CreditBalancePort.ts` | NEW |
| `src/domain/ports/MessagingRatesConfigRepository.ts` | NEW |
| `src/infrastructure/adapters/in-memory/InMemoryCreditBalancePort.ts` | NEW |
| `src/__tests__/infrastructure/adapters/in-memory/InMemoryCreditBalancePort.test.ts` | NEW |
| `src/infrastructure/adapters/in-memory/InMemoryMessagingRatesConfigRepository.ts` | NEW |
| `src/__tests__/infrastructure/adapters/in-memory/InMemoryMessagingRatesConfigRepository.test.ts` | NEW |
| `src/infrastructure/adapters/prisma/PrismaMessagingRatesConfigRepository.ts` | NEW |
| `src/__tests__/infrastructure/PrismaMessagingRatesConfigRepository.test.ts` | NEW |
| `src/infrastructure/adapters/twilio/TwilioCreditBalanceGateway.ts` | NEW |
| `src/__tests__/infrastructure/TwilioCreditBalanceGateway.test.ts` | NEW |

`git status --short` (worktree) confirma únicamente estos archivos + `openspec/changes/twilio-credit-guard/` — cero archivos fuera de scope.

## Deviations from Design
None — implementación matches design D1/D2/D3 tal cual.

## Issues Found
None bloqueante. Ruido pre-existente en la corrida completa: varios `console.error`/`console.log` post-teardown de `PrismaAuditEventRepository`/`auditMutationsMiddleware` ("Authentication failed against the database server... 'ipnext'") en tests NO relacionados con este change (audit logging contra una DB de test sin credenciales válidas) — no afecta el resultado (`exit code 0`, cero suites `FAIL`), es un log async post-`afterAll` de otra capability, preexistente al branch.

## Batch B2 — `estimateMessagingCost` + `ValidateExternalBulk` extendido + config use cases (D4.a, D4.b, D4.e) + `GetMessagingCredit` (D4.d, adelantado de B3)

Status: **COMPLETE** — 6/6 tasks del batch (2.1-2.6) + Gate B2 + task 3.3 (`GetMessagingCredit`)
adelantada por instrucción explícita del orquestador.

- [x] 2.1/2.2 `src/application/use-cases/messaging/EstimateMessagingCost.ts` (NEW, módulo PURO) +
  `src/__tests__/application/messaging/EstimateMessagingCost.test.ts` — 11 tests: 3 categorías con
  unitCost exacto (UTILITY 0.0170), categoría ausente/desconocida ⇒ MARKETING + `categoryAssumed`,
  balance null ⇒ `unknown`+`sufficient:false`, mismatch de moneda ⇒ `unknown` (nunca comparación a
  ciegas), tarifa ilegible (`tryParseMoney` null) ⇒ `unknown` (nunca tratada como 0), lote de 500
  determinístico (`8.5000` exacto), límite exacto `estimatedCost===available` ⇒ `sufficient:true`.
- [x] 2.3/2.4 `src/application/use-cases/messaging/GetMessagingRatesConfig.ts` +
  `SetMessagingRatesConfig.ts` (NEW, clon 1:1 de Get/SetExternalBulkConfig) + tests — 2 + 8 tests:
  defaults sin fila (RATES-1), rechazo de negativos/>4 decimales/number-en-vez-de-string/notación
  exponencial/currency inválida (RATES-2, `DECIMAL_4_RE`/`CURRENCY_RE`), normalización
  `formatMoney(parseMoney(x))` antes de persistir.
- [x] 2.5/2.6 `src/application/dto/external-bulk-messaging.dto.ts` (MOD: `credit`+`warnings?` en
  `ValidateExternalBulkOutput`, `ExternalBulkWarning` type) + `ValidateExternalBulk.ts` (MOD: 2 deps
  nuevas `creditPort`/`ratesRepo` ANTES de `now`, bloque 9.5 CRÉDITO insertado entre el cierre de
  caps y el comentario de persist preview, método privado `resolveCredit`) +
  `ValidateExternalBulk.test.ts` (MOD: +8 tests nuevos en describe dedicado) — 62/62 verdes.
  - Pin de no-regresión del hash: `payloadHash` literal capturado
    (`b9deaf15c46833d24da7bee0d9de80641e9038442d9f8de9583b8047499b886a`) para el payload canónico de
    `baseInput()` — idéntico con y sin crédito calculado, Y test dinámico adicional (tarifas
    cambiadas entre 2 previews del MISMO payload ⇒ mismo hash, distinto `credit.unitCost`).
  - Pin de orden: cap excedido ⇒ `creditPort.calls === 0` (`getBalance()` NUNCA se llama antes de
    que el cap tire) — crédito corre estrictamente DESPUÉS de los caps.
  - Warnings: `INSUFFICIENT_CREDIT` (sufficient:false) | `CREDIT_UNAVAILABLE` (unknown:true, incluye
    `creditPort.failNext` Y `ratesRepo.get()` lanzando con fallback a `MESSAGING_RATES_CONFIG_DEFAULTS`)
    | ausente (array vacío nunca viaja al wire) — todos como 200, JAMÁS 4xx/5xx.
- [x] 3.3 (adelantada) `src/application/use-cases/messaging/GetMessagingCredit.ts` (NEW, D4.d) +
  test — 3/3: combina `creditPort.getBalance()`+`ratesRepo.get()` via `Promise.all`, `cached`
  pass-through, `getBalance()` lanza ⇒ propaga `CreditUnavailableError` tal cual (acá SÍ es error).
  Sin wiring — eso sigue siendo B3 (`app.ts`, `GET /credit`, router de config admin).
- [x] Gate B2: `npx tsc --noEmit` limpio; suite completa del repo verde (ver Test Summary abajo).

### Entidad/port/adapters tocados para `credit` (fuera de tasks.md explícito, load-bearing para 2.5/2.6)

- `src/domain/entities/externalBulkPreview.ts` (MOD): tipos `ExternalBulkPreviewCreditCategory` +
  `ExternalBulkPreviewCreditSnapshot` declarados LOCALMENTE en dominio (estructuralmente idénticos a
  `MessagingCreditDto` de `application/`, mismo criterio que `ExternalBulkPreviewRecipient` vs
  `ValidateExternalBulkValidRecipientDto` — el dominio NUNCA importa un tipo de `application/`, DIP
  estricto) + campo `credit: ExternalBulkPreviewCreditSnapshot | null` en la entidad.
- `src/domain/ports/ExternalBulkPreviewRepository.ts` (MOD): `ExternalBulkPreviewCreateData.credit?`
  OPCIONAL (no requerido) — evita romper callers que arman un preview a mano sin crédito (ej. el
  test D9 de purga en `ValidateExternalBulk.test.ts`, que crea un preview directo vía `previewRepo.create()`
  sin pasar por el use case). Ausente ⇒ `null` en la entidad, nunca un valor fabricado.
- `InMemoryExternalBulkPreviewRepository.ts` / `PrismaExternalBulkPreviewRepository.ts` (MOD): ambos
  persisten `data.credit ?? null` — Prisma ya tenía la columna `credit Json?` desde B1 (schema), solo
  faltaba el mapeo del adapter (`row.credit` ↔ `ExternalBulkPreview.credit`).
- `src/infrastructure/http/app.ts` (MOD, MÍNIMO — desviación deliberada de "no app.ts en B2"): el
  cambio de firma del constructor de `ValidateExternalBulk` (2 deps nuevas OBLIGATORIAS, D4.b) rompe
  la compilación del ÚNICO call site de producción si no se toca. Se instanciaron
  `creditBalancePort = new TwilioCreditBalanceGateway({accountSid, authToken})` +
  `messagingRatesRepo = new PrismaMessagingRatesConfigRepository()` (molde D6, mismas creds, cero
  env nueva) y se pasaron SOLO a `new ValidateExternalBulk(...)`. `SendExternalBulk` (sin tocar en
  B2, su constructor no cambió) sigue con su firma actual. **NADA MÁS de D6 se hizo**: sin `GET
  /credit`, sin mount de `messaging-rates-config.routes.ts`, sin `GetMessagingCredit` en las router
  deps — eso es 100% B3 (3.5/3.8). B3 debe REUSAR la MISMA instancia de `creditBalancePort` para
  `SendExternalBulk` (D6 — cache de 60s compartida validate/send), no crear una nueva.
- 3 test files de rutas/composición (`external-messaging.routes.test.ts`,
  `external-messaging-templates.routes.test.ts`, `external-bulk-messaging-composition.test.ts`)
  actualizados con `InMemoryCreditBalancePort`/`InMemoryMessagingRatesConfigRepository` en sus
  `new ValidateExternalBulk(...)` — todos siguen verdes, sin cambios de aserciones (ningún test
  asserteaba el body completo de `/validate` con `toEqual` exacto, así que agregar `credit`/`warnings`
  al wire no rompió nada).

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 2.1 | `.../EstimateMessagingCost.test.ts` | Unit | N/A (new) | ✅ Written | ✅ 11/11 | ✅ 3 categorías + assumed + null + moneda + ilegible + límite exacto + lote 500 | ➖ None needed |
| 2.3 | `.../GetMessagingRatesConfig.test.ts` | Unit | N/A (new) | ✅ Written | ✅ 2/2 | ✅ defaults + persistido | ➖ None needed |
| 2.3 | `.../SetMessagingRatesConfig.test.ts` | Unit | N/A (new) | ✅ Written | ✅ 8/8 | ✅ negativo/4-decimales/number/exponencial/currency×2/normalización/persist | ➖ None needed |
| 2.5 | `.../ValidateExternalBulk.test.ts` (extendido) | Unit | ✅ 54/54 pre-existentes | ✅ Written | ✅ 62/62 | ✅ 8 casos: shape, insuficiente, inalcanzable, rates-fallback, snapshot, hash-pin, hash-estable, orden-vs-caps | ➖ None needed |
| 3.3 | `.../GetMessagingCredit.test.ts` | Unit | N/A (new) | ✅ Written | ✅ 3/3 | ✅ shape + cached:true + propaga error | ➖ None needed |

### Test Summary
- **Total tests escritos en B2**: 32 (11 + 2 + 8 + 8 + 3)
- **Total tests pasando (suites de B2)**: 32/32, cero regresiones en las 54 pre-existentes de
  `ValidateExternalBulk.test.ts` (54→62) ni en las 3 suites de rutas/composición tocadas (92/92).
- **Suite COMPLETA del repo** (`npm test`, post-B2, lanzada en background + polling del log):
  `Test Suites: 6 skipped, 1263 passed, 1269 total` · `Tests: 88 skipped, 13157 passed, 13245 total`
  · cero `FAIL`. Delta vs B1 (1265→1269 suites, 13213→13245 tests): exactamente +4 suites nuevas
  (EstimateMessagingCost/GetMessagingRatesConfig/SetMessagingRatesConfig/GetMessagingCredit) y +32
  tests, sin sorpresas.
- **`npx tsc --noEmit`**: limpio, sin output.
- **Procesos jest**: verificado 0 antes de lanzar (`wmic ... | rg -c jest` → sin matches) y 0 después
  de que el log mostrara `Tests:` (mismo chequeo, mismo resultado).
- **Layers usadas**: Unit (32), Integration (0), E2E (0).
- **Pure functions creadas**: `estimateMessagingCost` (1, D4.a — normalizeCategory/rateFor internos
  no exportados).

## Archivos tocados en B2

| Archivo | Acción |
|---|---|
| `src/application/use-cases/messaging/EstimateMessagingCost.ts` | NEW |
| `src/__tests__/application/messaging/EstimateMessagingCost.test.ts` | NEW |
| `src/application/use-cases/messaging/GetMessagingRatesConfig.ts` | NEW |
| `src/__tests__/application/messaging/GetMessagingRatesConfig.test.ts` | NEW |
| `src/application/use-cases/messaging/SetMessagingRatesConfig.ts` | NEW |
| `src/__tests__/application/messaging/SetMessagingRatesConfig.test.ts` | NEW |
| `src/application/use-cases/messaging/GetMessagingCredit.ts` | NEW (adelantada de 3.3) |
| `src/__tests__/application/messaging/GetMessagingCredit.test.ts` | NEW (adelantada de 3.3) |
| `src/application/dto/external-bulk-messaging.dto.ts` | MOD |
| `src/application/use-cases/messaging/ValidateExternalBulk.ts` | MOD |
| `src/__tests__/application/messaging/ValidateExternalBulk.test.ts` | MOD |
| `src/domain/entities/externalBulkPreview.ts` | MOD |
| `src/domain/ports/ExternalBulkPreviewRepository.ts` | MOD |
| `src/infrastructure/adapters/in-memory/InMemoryExternalBulkPreviewRepository.ts` | MOD |
| `src/infrastructure/adapters/prisma/PrismaExternalBulkPreviewRepository.ts` | MOD |
| `src/infrastructure/http/app.ts` | MOD (mínimo, solo para compilar `ValidateExternalBulk`) |
| `src/__tests__/infrastructure/external-messaging.routes.test.ts` | MOD (2 deps nuevas en construcción) |
| `src/__tests__/infrastructure/external-messaging-templates.routes.test.ts` | MOD (ídem) |
| `src/__tests__/infrastructure/external-bulk-messaging-composition.test.ts` | MOD (ídem) |

`git status --short` (worktree) confirma únicamente archivos de B1+B2 + `openspec/changes/twilio-credit-guard/` — cero archivos fuera de scope.

## Deviations from Design (B2)

- **`GetMessagingCredit` (3.3) adelantada a B2**: instrucción EXPLÍCITA del orquestador en el prompt
  de arranque de este batch ("B2 scope: ... `GetMessagingCredit` ..."), aunque tasks.md la agrupa
  formalmente en Batch 3. Implementada tal cual D4.d, sin wiring (eso sigue en B3).
- **`app.ts` tocado en B2** pese a la instrucción "no app.ts en B2 (B3 wires)": inevitable — el
  cambio de firma del constructor de `ValidateExternalBulk` (2 deps NUEVAS y OBLIGATORIAS, no
  opcionales, por diseño D4.b explícito "quedando 11") rompe la compilación del único call site de
  producción. Se hizo el cambio MÍNIMO posible (2 instancias + pasarlas a `ValidateExternalBulk`),
  documentado en detalle arriba. Ningún otro pedazo de D6 (rutas, mounts, `GetMessagingCredit` en
  deps) se tocó — eso es 100% B3.
- **`ExternalBulkPreviewCreateData.credit` es OPCIONAL**, no obligatorio como insinúa la lectura
  literal de D4.b ("Se suma a `ExternalBulkPreviewCreateData`"): necesario para no romper el test D9
  de purga en `ValidateExternalBulk.test.ts` (arma un preview a mano sin credit). Comportamiento:
  ausente ⇒ `null` en la entidad.
- Fuera de eso: implementación matches design D4.a/D4.b/D4.d/D4.e tal cual.

## Issues Found (B2)
Ninguno bloqueante. Mismo ruido preexistente post-`afterAll` de `PrismaAuditEventRepository` ya
documentado en B1 (logs async de audit contra una DB de test sin credenciales, no relacionado a este
change, `exit code` de la suite completa sigue siendo verde).

## Notes for B3

- **Firma EXACTA del constructor de `ValidateExternalBulk`** (11 params, orden estricto):
  ```ts
  new ValidateExternalBulk(
    previewRepo: ExternalBulkPreviewRepository,
    configRepo: ExternalBulkMessagingConfigRepository,
    campaignRepo: CampaignRepository,
    templatePort: TemplateMessagingPort,
    segmentSource: CampaignSegmentSource,
    chatwootGateway: ChatwootGateway,
    featureFlags: FeatureFlagRepository,
    rbacUserRepo: RbacUserRepository,
    creditPort: CreditBalancePort,           // NEW (B2)
    ratesRepo: MessagingRatesConfigRepository, // NEW (B2)
    now: () => Date = () => new Date(),      // default, puede omitirse
  )
  ```
- `SendExternalBulk` (B3, 3.2) recibe las MISMAS 2 deps nuevas en el MISMO orden relativo (antes de
  `now`), quedando 12 params — mismas 2 INSTANCIAS que `ValidateExternalBulk` en `app.ts` (D6, cache
  compartida). En `app.ts`, las variables `creditBalancePort`/`messagingRatesRepo` YA EXISTEN
  (instanciadas en B2 dentro del bloque bulk, líneas justo antes de `app.use('/api/external/v1/messaging/bulk'`)
  — B3 debe REUSARLAS para `SendExternalBulk`, NO crear instancias nuevas (si no, se pierde la cache
  de 60s compartida validate/send que D6 exige explícitamente).
- `GetMessagingCredit` YA EXISTE y está probado (3/3) — B3 solo necesita wirearlo: `new
  GetMessagingCredit(creditBalancePort, messagingRatesRepo)` en las deps del router (D5.a) y otra
  instancia PROPIA para el router de config admin (D5.c/D6) — **SUPERADO por fix wave F1 (R2#4): instancia ÚNICA compartida**.
- `MessagingCreditDto`/`MessagingTemplateCategory` viven en `EstimateMessagingCost.ts`
  (`@application/use-cases/messaging/EstimateMessagingCost`) — B3 los importa desde ahí para
  `SendExternalBulk`'s `assertSufficientCredit` (D4.c).
- `creditWarnings()` (helper privado, NO exportado, vive dentro de `ValidateExternalBulk.ts`) — si
  B3 necesita la misma lógica de mapeo `credit → warnings[]` en otro lugar, extraerla a un módulo
  compartido en vez de duplicar el `if (unknown) ... else if (!sufficient) ...`.
- El bloque `9.5 — CRÉDITO` de `ValidateExternalBulk.ts` vive ENTRE el `throw CapExceededError` de
  `perDay` y el comentario `// 10 — VAL-8`. `SendExternalBulk` (3.2) debe insertar su `4.5 — GATE`
  análogo ENTRE el cierre de la re-validación SEND-4 (cap `remainingToday`) y el comentario de
  `CreateCampaign` — MISMO criterio de "después de los caps, antes de crear nada" pineado en B2 con
  el test `creditPort.calls === 0` cuando un cap excedido tira primero.
- **Riesgo pineado para B3 (heredado de B2)**: el hash literal
  `b9deaf15c46833d24da7bee0d9de80641e9038442d9f8de9583b8047499b886a` en
  `ValidateExternalBulk.test.ts` es del payload canónico de `baseInput()` — si B3 toca
  `externalBulkPayloadHash.ts` o el orden de campos de recipients/variables en `ValidateExternalBulk`,
  ese test se rompe y es la señal de alarma (CG-VAL-2).
- `InsufficientCreditError`/`CreditUnavailableError` siguen en el statusMap desde B1 — la ruta
  (`external-messaging.routes.ts`, B3 3.4/3.5) sigue necesitando el bloque `details` manual para el
  422 (D5.b), el `errorHandler` no lo serializa.

## Batch B3 — `SendExternalBulk` gate + rutas `GET /credit` + config admin + `app.ts` wiring (D4.c, D4.d, D5, D6)

Status: **COMPLETE** — 8/8 tasks (3.1-3.8, `3.3` ya venía COMPLETE desde B2) + Gate B3.

- [x] **3.1/3.2** `SendExternalBulk.ts` (MOD): 2 deps nuevas al constructor
  (`creditPort: CreditBalancePort`, `ratesRepo: MessagingRatesConfigRepository`), inyectadas ANTES
  del `now` con default, quedando 12 (D4.c exacto). Método privado `assertSufficientCredit(category,
  count)` insertado ENTRE el cierre de la re-validación SEND-4 (cap `remainingToday`) y el comentario
  de `CreateCampaign` — punto de inserción EXACTO de D4.c. `ratesRepo.get()` SIN fallback a defaults
  (a diferencia de `ValidateExternalBulk`, acá si el repo revienta sube tal cual — D4.c "no se
  adivina"); `getBalance()` lanza ⇒ `CreditUnavailableError`; `credit.unknown` ⇒
  `CreditUnavailableError`; `!credit.sufficient` ⇒ `InsufficientCreditError({available,
  estimatedCost, currency})`. El método `private async replay(...)` NO se tocó — ni una línea.
  `SendExternalBulk.test.ts` (MOD): `setup()` suma `creditPort`/`ratesRepo` (saldo AMPLIO
  '10000.0000' USD por default para no romper los tests SEND-1..SEND-10 preexistentes por
  casualidad) + 10 tests nuevos (CG-SEND-2/3/4/5 + 2 de orden D0) — 84/84 verdes en el archivo.
- [x] **3.3** `GetMessagingCredit` — ya estaba COMPLETE desde B2 (adelantada por instrucción del
  orquestador), sin cambios en B3 más que su wiring (ver 3.5/3.8).
- [x] **3.4/3.5** `external-messaging.routes.ts` (MOD, D5.a/D5.b): `GET /credit` (ruta hermana de
  `GET /campaigns/:id`, sin `writeRateLimiter`, kill-switch explícito ANTES de tocar Twilio, molde
  `isFeatureEnabled()`) → 200 `{available,currency,fetchedAt,cached,rates}` / 503
  `CREDIT_UNAVAILABLE` / 403 `FEATURE_DISABLED` / 401 sin key. `ExternalMessagingRouterDeps` suma
  `getMessagingCredit: GetMessagingCredit`. Bloque `if (err instanceof InsufficientCreditError)` en
  el catch de `/send` (D5.b, junto al de `CampaignRunnerBusyError`), 422 con `details:{available,
  estimatedCost, currency}` armado EN LA RUTA — `CreditUnavailableError` no necesita nada extra (503
  del statusMap alcanza). `external-messaging.routes.test.ts` (MOD): `buildApp()` suma
  `creditAmount`/`creditCurrency`/`creditFails` opts + `getMessagingCredit` en las deps (MISMA
  instancia de `creditPort`/`ratesRepo` que validate/send) + 9 tests nuevos (`GET /credit` ×4,
  `/send` 422/503 ×2, `/validate` warnings ×2, `CG-AUDIT-1` ×1).
  `external-messaging-templates.routes.test.ts` / `external-bulk-messaging-composition.test.ts`
  (MOD, scaffolding obligatorio): `getMessagingCredit` sumado a sus `deps` + `creditPort`/`ratesRepo`
  pasados a `SendExternalBulk` — sin esto no compilaban (firma de 12 args).
- [x] **3.6** `messaging-rates-config.routes.ts` (NEW, D5.c, kebab-case): `GET /` (`messaging:read`)
  → tarifas flat; `PUT /` (`messaging:manage`) → idem + 400 `VALIDATION_ERROR`; `GET /balance`
  (`messaging:read`) → `{available,currency,fetchedAt,cached}` SIN el bloque `rates` (la card FE ya
  lo tiene de `GET /`) / 503 `CREDIT_UNAVAILABLE`. Molde línea-por-línea de
  `externalBulkMessagingConfig.routes.ts`. `messaging-rates-config.routes.test.ts` (NEW) — 14 tests:
  defaults RATES-1, FLAT sin envelope, 403×2 (read/manage), 5 casos 400 (negativo, >4 decimales,
  currency minúscula, currency 4 letras, `number` en vez de `string`), `GET /balance` 200/503/403.
- [x] **3.7/3.8** `twilio-credit-guard-composition.test.ts` (NEW, molde
  `external-bulk-messaging-composition.test.ts` parte (a), scan de FUENTE de `app.ts`, sin bootear
  `createApp()` real) — 9 tests: marcador `[external-bulk-mount-end]` intacto; mount de
  `/api/messaging/config/rates` existe y queda DESPUÉS del de `/external-bulk`; gates
  `messaging:read`/`messaging:manage`; `ValidateExternalBulk`/`SendExternalBulk` reciben
  `TwilioCreditBalanceGateway`+`PrismaMessagingRatesConfigRepository`; **la MISMA instancia**
  `creditBalancePort`/`messagingRatesRepo` (declaradas UNA sola vez, `const`) se pasa a AMBOS use
  cases + a `getMessagingCredit` del router externo; el router de config admin usa instancias
  PROPIAS (`messagingRatesRepoForRoute`/`creditPortForRoute`), nunca las del bloque bulk.
  `app.ts` (MOD, D6): `SendExternalBulk` ahora recibe `creditBalancePort, messagingRatesRepo` (las
  MISMAS instancias ya creadas en B2 para `ValidateExternalBulk` — NO se crearon nuevas); router
  deps suma `getMessagingCredit: new GetMessagingCredit(creditBalancePort, messagingRatesRepo)`;
  bloque nuevo self-contained pegado DESPUÉS del de `/api/messaging/config/external-bulk` (mismo
  molde; las instancias propias `messagingRatesRepoForRoute`/`creditPortForRoute` fueron UNIFICADAS en fix wave F1 R2#4) monta
  `/api/messaging/config/rates`. Sin env vars nuevas.
- [x] **Gate B3**: `npx tsc --noEmit` limpio. Suite completa del repo verde (ver Test Summary abajo).

### Gotcha de implementación — ventana de texto del composition test (self-inflicted, corregido en el mismo batch)

El primer intento de `twilio-credit-guard-composition.test.ts` reusaba el mismo recorte de ventana
(`MOUNT_START..MOUNT_END`) que `external-bulk-messaging-composition.test.ts`, pero las declaraciones
`const creditBalancePort = ...`/`const messagingRatesRepo = ...` viven ANTES de `app.use('/api/
external/v1/messaging/bulk',` (D6), fuera de esa ventana — 3 tests fallaban en falso (RED por un bug
del TEST, no de la implementación). Fix: ancla nueva (`BLOCK_START` en la primera `const` del bloque
bulk entero) para las assertions que necesitan ver las declaraciones + el mount en la misma ventana.
Para el bloque de config admin (objetos literales anidados `{read, manage}` + options-object de
`TwilioCreditBalanceGateway` rompían un balanceo naive de llaves `lastIndexOf('{')`/`indexOf('}')`)
se usó un slice de longitud fija anclado a una declaración estable en vez de balancear llaves —
mismo patrón que ya usan otros bloques de este mismo archivo (`sendBlock = ...slice(idx, idx+400)`).

### Deviation NOTADA (no un bug de código, un gap spec↔implementación) — CG-SEND-1 "9 vs 10"

`spec.md` (CG-SEND-1) y `tasks.md` (3.1) describen un escenario: "preview con 10 `valid`, uno dado
de baja DESPUÉS del `validate` ⇒ el re-chequeo de crédito usa 9 destinatarios, no 10". La
implementación (D4.c, código EXACTO del design, pineado como "punto de inserción exacto") pasa
`preview.recipients.length` tal cual — el mismo criterio YA vigente para los CAPS existentes
(`preview.recipients.length > remainingToday`, SEND-4, sin recompute de opt-out), documentado
explícitamente en el propio `SendExternalBulk.ts` (comentario junto a `manualContacts`: un chequeo
de opt-out PROPIO en este use case fue probado y descartado por duplicar una fuente de verdad que
`CreateCampaign`/`matchManualContacts` ya resuelve, confirmado con un probe de mutación). Como el
gate de crédito (4.5) corre ANTES de `CreateCampaign` (5, que es quien recién ahí filtra opt-outs
contra el `CampaignSegmentSource` VIVO), el conteo de 9 real NO está disponible en 4.5 sin duplicar
esa lógica — algo que el propio design.md NO pide (su código no incluye ningún filtro de opt-out
antes de `assertSufficientCredit`). Se implementó literal a D4.c (preview.recipients.length, "10");
el test que cubre CG-SEND-1 en este batch verifica el comportamiento REAL (re-chequeo fresco contra
`preview.recipients.length`, no un valor cacheado del `validate`), no el número "9" literal del
spec, porque escribir una aserción que espere "9" sería una aserción trivial que no corresponde a
NINGÚN código real (banned assertion pattern — nunca falsificar un GREEN). **Bandera para
`sdd-verify`**: este es un gap genuino entre `spec.md` y `design.md`/código — o se corrige el spec
(quitar la expectativa de recompute de opt-out para crédito, igual que los caps) o se agrega scope
nuevo (pasar `segmentSource` a `SendExternalBulk` para recomputar opt-outs antes del gate de
crédito, fuera del alcance de D4.c tal como está escrito). No se tomó la decisión unilateralmente en
`sdd-apply` — se documenta para que el orquestador/usuario decida.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 3.1/3.2 | `SendExternalBulk.test.ts` | Unit | ✅ 84 pre-existentes (tras fix de ctor) | ✅ Written (RED confirmado: `tsc` error TS2554 "Expected 9-10, got 12" antes del fix de ctor) | ✅ 84/84 | ✅ 10 casos nuevos: insuficiente+details, inalcanzable, moneda≠, replay sin re-chequeo, tarifas-en-0, orden×2 (cap/template) | ➖ None needed |
| 3.4/3.5 | `external-messaging.routes.test.ts` | Integration (supertest, use cases reales) | ✅ 30 pre-existentes | ✅ Written | ✅ 39/39 en el archivo | ✅ 9 casos: credit 200/503/403/401, send 422-details/503, validate warnings×2, audit | ➖ None needed |
| 3.6 | `messaging-rates-config.routes.test.ts` | Integration (supertest) | N/A (new) | ✅ Written | ✅ 14/14 | ✅ RATES-1/2/3 completos (5 casos 400 + 2×403 + balance 200/503) | ➖ None needed |
| 3.7/3.8 | `twilio-credit-guard-composition.test.ts` | Unit (scan de fuente, sin DB) | N/A (new) | ✅ Written (RED confirmado: 3 fallos reales por ventana de texto mal anclada, corregidos) | ✅ 9/9 | ✅ mount, gates, identidad de instancia compartida (tras F1 R2#4: el router admin usa la MISMA instancia) | ➖ None needed |

### Test Summary
- **Total tests escritos en B3**: 42 (10 SendExternalBulk + 9 routes + 14 rates-config + 9
  composition; los 3 archivos de scaffolding — templates/composition/ValidateExternalBulk N/A —
  no suman tests nuevos, solo compilan).
- **Suite COMPLETA del repo** (`npm test`, post-B3, background + polling del log, jest procesos
  verificados 0 antes y después): `Test Suites: 6 skipped, 1265 passed, 1271 total` ·
  `Tests: 88 skipped, 13198 passed, 13286 total` · exit 0. Delta vs B2 (1269→1271 suites,
  13245→13286 tests): +2 suites nuevas (`messaging-rates-config.routes` +
  `twilio-credit-guard-composition`), +41 tests (los otros archivos MOD no suman tests netos salvo
  los 10 nuevos de `SendExternalBulk.test.ts` y los 9 de `external-messaging.routes.test.ts`).
- **`npx tsc --noEmit`**: limpio, sin output.
- **Procesos jest**: verificado 0 antes de lanzar y 0 después de que el log mostrara `Tests:`.
- **Layers usadas**: Unit (19), Integration/supertest (23).

## Archivos tocados en B3

| Archivo | Acción |
|---|---|
| `src/application/use-cases/messaging/SendExternalBulk.ts` | MOD — gate de crédito D4.c |
| `src/__tests__/application/messaging/SendExternalBulk.test.ts` | MOD — 10 tests CG-SEND-2..5 + orden |
| `src/infrastructure/http/routes/external-messaging.routes.ts` | MOD — `GET /credit` + 422 details |
| `src/__tests__/infrastructure/external-messaging.routes.test.ts` | MOD — 9 tests + getMessagingCredit dep |
| `src/infrastructure/http/routes/messaging-rates-config.routes.ts` | NEW |
| `src/__tests__/infrastructure/messaging-rates-config.routes.test.ts` | NEW |
| `src/__tests__/infrastructure/twilio-credit-guard-composition.test.ts` | NEW |
| `src/infrastructure/http/app.ts` | MOD — wiring D6 completo |
| `src/__tests__/infrastructure/external-messaging-templates.routes.test.ts` | MOD (scaffolding, getMessagingCredit dep) |
| `src/__tests__/infrastructure/external-bulk-messaging-composition.test.ts` | MOD (scaffolding, getMessagingCredit dep) |

`git status --short` (worktree) confirma únicamente archivos de B1+B2+B3 + `openspec/changes/
twilio-credit-guard/` — cero archivos fuera de scope.

## Deviations from Design (B3)

- Ver "Deviation NOTADA — CG-SEND-1" arriba: gap genuino spec↔design en el recompute de opt-out
  para el gate de crédito. Implementado literal a D4.c; bandera levantada para `sdd-verify`.
- Fuera de eso: implementación matches design D4.c/D5.a/D5.b/D5.c/D6 tal cual, incluidos los puntos
  de inserción EXACTOS citados por el design (`assertSufficientCredit` en el mismo lugar que
  `resolveCredit` de `ValidateExternalBulk` respecto a los caps).

## Issues Found (B3)
Ninguno bloqueante. Mismo ruido preexistente post-`afterAll` de `PrismaAuditEventRepository`/
`auditMutationsMiddleware` (logs async de audit contra una DB de test sin credenciales, ya
documentado en B1/B2, no relacionado a este change, `exit code` de la suite completa sigue en 0).

## Notes for B4 (FE, otro repo — `ipnext-frontend`)

- Contrato HTTP completo y estable para el FE: `GET /api/messaging/config/rates` (flat, 5 tarifas +
  `updatedAt`), `PUT /api/messaging/config/rates` (mismo shape, 400 `VALIDATION_ERROR`), `GET
  /api/messaging/config/rates/balance` (`{available,currency,fetchedAt,cached}`, SIN `rates`) — los
  3 gateados por sesión (`messaging:read`/`messaging:manage`), NO api-key.
- `GET /api/external/v1/messaging/bulk/credit` (key dedicada) trae AMBOS bloques juntos
  (`available/currency/fetchedAt/cached` + `rates`) — es el endpoint M2M, no lo usa la card FE.
- `POST .../validate` ahora devuelve `credit`+`warnings?` en el body — si el FE alguna vez consume
  `validate` directamente (fuera de scope de B4, ver D8), ahí están.
- `POST .../send` con crédito insuficiente devuelve 422 con `body.details = {available,
  estimatedCost, currency}` — shape estable para un banner de error en el FE si corresponde.
- Ningún env var nuevo, ninguna dependencia npm nueva en el BE — B4 es 100% capa de presentación.

---

# Fix wave F1

Review adversarial (R1 + R2) sobre el change ya implementado. 8 findings numerados (F1..F8) + 6
observaciones de R2. TDD estricto en todos: test rojo primero, fix, verde. `npx tsc --noEmit`
limpio; suite completa **1265 suites (6 skipped) / 13354 tests (88 skipped), 0 fallos**.

## F1 (HIGH) — cache rancia: el gate del `send` decidía contra el saldo PRE-gasto

**El bug.** El flujo M2M NORMAL es `validate` → `send` segundos después. `validate` llenaba el slot
de cache de 60 s de `TwilioCreditBalanceGateway`, y el gate fail-closed del `send` leía de ESE slot:
comparaba contra el saldo de ANTES de cualquier gasto intermedio. No era un borde raro — era el
camino feliz. D10.a ("cache de 60 s aceptada") estaba mal calibrado y quedó **REVISADO**.

**El fix.** `CreditBalancePort` suma `getBalance(opts?: {fresh?: boolean})` e `invalidate()`:
- el gate del `send` llama `getBalance({fresh: true})` — saltea el hit y REFRESCA el slot;
- el camino ADVISORY (`validate`, `GET /credit`, card admin) sigue usando la cache: ahí un número
  de hace 30 s informa, no decide plata;
- tras un `send` ACEPTADO (campaña creada + runner arrancado), `creditPort.invalidate()`
  (best-effort — invalidar una cache jamás puede voltear un envío ya aceptado).

Un `fresh` que FALLA no pisa ni destruye el slot vigente, y el error nunca se cachea.

Archivos: `src/domain/ports/CreditBalancePort.ts`,
`src/infrastructure/adapters/twilio/TwilioCreditBalanceGateway.ts`,
`src/application/use-cases/messaging/SendExternalBulk.ts`.
Tests: +4 en `TwilioCreditBalanceGateway.test.ts`, +4 en `SendExternalBulk.test.ts` (el escenario de
drenaje con reloj inyectable: cache a 10.0000 → saldo real a 0.0000 → send a t=30 s ⇒ 422).

## F2 (MED) — `InMemoryCreditBalancePort` era un stub, no un twin

Devolvía siempre el valor fresco con un `cached` decorativo (`cachedNext`). Con eso, F1 era
**intesteable** con el twin: no había cache que envenenar. Ahora replica campo a campo la semántica
del gateway — cache single-slot, reloj `now: () => number` inyectable, TTL default 60_000 (el MISMO
número), `cached` REAL, bypass `{fresh:true}`, `invalidate()`, error nunca cacheado.

Dos contadores con roles distintos: `calls` (invocaciones — pinea "el gate no corrió" / "el replay
no re-chequea") y `fetches` (lecturas de ORIGEN, el equivalente del `http.get` del gateway — es lo
que pinea la invalidación). `cachedNext` murió.

Archivos: `src/infrastructure/adapters/in-memory/InMemoryCreditBalancePort.ts`. Tests: +7 de
paridad, mismos escenarios que el gateway.

## F3 (MED) — sobregiro por concurrencia

Dos `send` simultáneos leían el MISMO saldo y ambos pasaban el gate: 2 × 8 = 16 USD gastados con 10
de saldo. El tramo **gate → `CreateCampaign` → `markConsumed` → `start`** ahora corre serializado en
un `AsyncMutex` (`src/application/use-cases/messaging/asyncMutex.ts`, cero dependencia npm nueva,
molde de ubicación `externalBulkPayloadHash.ts`).

`start()` entra en la sección crítica a propósito: es el punto donde el gasto se vuelve REAL; soltar
el candado antes admitiría un segundo send contra un saldo comprometido pero no drenado.

**Alcance DECLARADO** (D10.b, actualizado): protege UNA instancia del proceso, no un cluster.
Suficiente porque `CampaignRunner` ya es uno por proceso (lock global, D6). Si eso cambiara, el
candado sube a un advisory lock de Postgres — el mismo molde que ya usa el runner.

Spec: **CG-SEND-6** (nuevo requirement). Tests: 2 de concurrencia en `SendExternalBulk.test.ts` +
`asyncMutex.test.ts` (5, incluido "un rechazo no traba la cola").
**Revert-probe**: sacando el mutex, el test de sobregiro falla. Confirmado.

## F4 (MED) — `ratesRepo.get()` fuera del try ⇒ 500; y el Prisma repo inventaba tarifas

Dos caras del mismo error: adivinar una tarifa para decidir si se gasta plata real.

1. `SendExternalBulk.assertSufficientCredit` leía las tarifas FUERA del try/catch: un repo caído
   subía crudo y el `errorHandler` lo mapeaba a 500, cuando CG-SEND-3 dice 503 `CREDIT_UNAVAILABLE`.
   Ahora TODO el gate (rates + balance + estimador) está adentro del try.
2. `PrismaMessagingRatesConfigRepository.get()` tenía un `catch` que devolvía
   `MESSAGING_RATES_CONFIG_DEFAULTS` con un `updatedAt` fabricado cuando el upsert fallaba. **Se
   eliminó**: cualquier fallo de `findUnique`/`upsert` SUBE. El único camino que devuelve defaults
   es el lazy-create FELIZ, con el `updatedAt` REAL de la fila creada.
3. `ValidateExternalBulk.resolveCredit` ya no cae a defaults tampoco: `rates` es
   `MessagingRatesConfig | null` en `estimateMessagingCost`, y `null` degrada a `unknown` +
   warning `CREDIT_UNAVAILABLE`. Sigue sin voltear el 200 (CG-VAL-1 intacto).

Comentarios contradictorios (uno decía "sin fallback", el código tenía fallback) corregidos.

## F5 (MED) — fixtures degenerados: `estimatedCost === unitCost`

Todos los tests del gate usaban UN destinatario, así que la multiplicación por
`preview.recipients.length` nunca se ejercitaba. Tests nuevos con **3** (0.2004 = 3 × 0.0668) y
**500** (33.4000 = 500 × 0.0668) destinatarios, en `SendExternalBulk.test.ts` **y** en el test de
ruta (`external-messaging.routes.test.ts`, incluido el `details` del 422 y el bloque `credit` del
200 de `validate`), más el borde exacto (saldo == costo ⇒ 202).

**Mutation-probe**: reemplazando `preview.recipients.length` por `1`, los tests nuevos fallan (2
rojos). Antes del fix, la suite quedaba verde con esa mutación.

## F6 (MED) — `MoneyParseError` no es `DomainError` ⇒ 500

Dos caminos lo alcanzaban:

- **`SetMessagingRatesConfig`**: la regex no capeaba la parte entera. La columna es `DECIMAL(10,4)`
  (máx. 999999.9999): `'1000000'` pasaba y reventaba río abajo. Ahora `^\d{1,6}(\.\d{1,4})?$`
  expresa el tope EXACTO, y el rechazo es `ExternalBulkValidationError` ⇒ **400** con un mensaje que
  nombra el máximo (mostrable por el FE). `999999.9999` sigue siendo válido — el borde no se cierra
  de más.
- **`estimateMessagingCost`**: `multiplyMoneyByCount` tira en overflow de safe-integer. El módulo se
  documenta como "nunca tira" y sus dos consumidores dependen de eso. Ahora el overflow degrada a
  `unknown` ADENTRO. En el gate del send eso es 503; en validate, `unknown` + warning.

## F7 (LOW-MED) — perilla propia del guard

Sin ella, el único botón ante un falso positivo del guard era apagar la API externa ENTERA: matar
el envío para arreglar el medidor. Feature flag **`messaging-credit-guard-enabled`**, sembrado en
**TRUE** en la migración de ESTE change (`20261113000000_messaging_rates_config`, mismo patrón
`ON CONFLICT DO NOTHING` que `messaging-external-bulk-enabled`; la migración no está deployada).

Semántica INVERSA a la del kill-switch: **fila ausente o repo caído ⇒ ON** (fail-closed; una
protección no se apaga sola). Con el flag en OFF:
- `validate` ⇒ `credit.unknown:true`, `unitCost/estimatedCost: null`, `warnings:
  ["CREDIT_GUARD_DISABLED"]`, CERO requests al proveedor;
- `send` ⇒ saltea el gate por completo (fail-OPEN por decisión EXPLÍCITA del operador).

El kill-switch general sigue mandando (guard OFF + API externa OFF ⇒ 403 `FEATURE_DISABLED`).
Se opera con el `PATCH /api/admin/feature-flags/:key` genérico que YA existe (gate `admin.flags`) —
**cero trabajo de FE**. Spec: **CG-FLAG-1**. Design: **D10.h**.

## F8 (LOW) — `unitCost`/`estimatedCost` decían "0.0000" con la tarifa ilegible

Un cero es un NÚMERO: la card FE y la IA que consume la API externa lo leen como "gratis". Tipo
nuevo: `string | null` en `MessagingCreditDto`, en `ExternalBulkPreviewCreditSnapshot` y por lo
tanto en el wire de `POST /validate`.

Regla exacta: `null` **solo** cuando falló la lectura del COSTO (tarifa ilegible, repo caído,
overflow, guard apagado). Si lo que falló fue el SALDO (balance inalcanzable, moneda distinta), el
bloque viaja `unknown:true` con `available:null` pero **los costos siguen siendo números** — se
conocen y son información útil. Cambio ADITIVO. Spec: **CG-WIRE-1**. Design: **D5.d**.

## R2 #1 — spec CG-SEND-1 desalineada con el código

La spec pedía "el re-chequeo usa 9 destinatarios, no 10" tras un opt-out entre validate y send. El
código tarifa `preview.recipients.length` (10) y `CreateCampaign` re-resuelve opt-outs por su
cuenta. **Se alineó la SPEC al código**, no al revés: el sesgo es deliberado (el gate puede bloquear
de más, NUNCA de menos), y contar después de `CreateCampaign` exigiría chequear el crédito DESPUÉS
del side-effect que el gate existe para prevenir. CG-SEND-1 reescrito con esa nota + los escenarios
de cache fresca, invalidación y escala por N.

## R2 #3 — docstring de `CreditUnavailableError` mentía

Decía que `GetMessagingCredit` compara monedas. No lo hace: solo PROPAGA lo que tire el port
(CRED-2). El chequeo de moneda vive en `estimateMessagingCost` (COST-4) y solo `SendExternalBulk` lo
convierte en este error — en `validate` el mismo mismatch es un warning del 200.

## R2 #4 — DOS instancias de `TwilioCreditBalanceGateway` en `app.ts`

El bloque bulk tenía la suya y el router de config admin una `creditPortForRoute` propia, "por
anti-interleave". El costo real no eran las 2 requests/minuto extra: eran **dos caches de 60 s con
vidas independientes sobre el MISMO saldo** — dos verdades simultáneas, y una invalidación
post-send que solo alcanzaba a una. Unificadas en UNA, hoisteada arriba del bloque bulk.

`twilio-credit-guard-composition.test.ts` se reescribió: el pin ahora es "existe EXACTAMENTE UNA
instanciación de `TwilioCreditBalanceGateway` en todo `app.ts`" (el pin anterior exigía justo lo
contrario — ese pin ERA el bug). Design: **D10.i**.

## R2 #6 — round-trip de `ExternalBulkPreview.credit` sin cobertura

La columna JSONB es nueva y ningún test tocaba escritura→lectura del adapter Prisma. +5 tests
(fake-client, molde de los hermanos) + 3 de paridad en el twin in-memory, incluyendo el caso
`unknown` con costos `null` y la fila sin `credit` (previews anteriores al change ⇒ `null`).

## R2 #7 — slice de longitud fija en el composition test

`appSrc.slice(idx, idx + 900)`: los `expect(block).not.toMatch(...)` pasaban por VACUIDAD apenas el
bloque creciera un renglón. Ahora la ventana se ancla al SIGUIENTE `app.use(` (el final real), con
un test que verifica que la ventana no se come el router vecino y que contiene su propio cierre.
Los comentarios se filtran antes de assertear, para que una mención en prosa no satisfaga un
`not.toMatch`.

## R2 #8 — asimetría de kill-switch documentada

`GET /credit` (router EXTERNO) está detrás de `messaging-external-bulk-enabled` (403 con el flag
OFF). `GET /api/messaging/config/rates/balance` (router ADMIN) **no**, y es correcto: el kill-switch
apaga el ENVÍO M2M, no la capacidad del operador de mirar cuánto saldo hay — lo primero que uno
quiere ver cuando acaba de apagar los envíos. Pineado ESTRUCTURALMENTE (el router admin no recibe ni
menciona un `FeatureFlagRepository`). Spec: **CG-AUTH-2**. Design: **D5.d**.

## Archivos tocados (fix wave F1)

Producción:
- `src/domain/ports/CreditBalancePort.ts` — `GetBalanceOptions`, `invalidate()`
- `src/domain/entities/externalBulkPreview.ts` — costos nullable en el snapshot
- `src/domain/errors/external-bulk-messaging.ts` — docstring (R2 #3)
- `src/application/dto/external-bulk-messaging.dto.ts` — warning `CREDIT_GUARD_DISABLED`
- `src/application/use-cases/messaging/asyncMutex.ts` — **NUEVO**
- `src/application/use-cases/messaging/EstimateMessagingCost.ts` — `rates` nullable, costos
  nullable, overflow contenido
- `src/application/use-cases/messaging/SetMessagingRatesConfig.ts` — tope `DECIMAL(10,4)`
- `src/application/use-cases/messaging/SendExternalBulk.ts` — mutex, `fresh`, `invalidate`, gate
  fail-closed completo, flag del guard
- `src/application/use-cases/messaging/ValidateExternalBulk.ts` — sin fallback a defaults, flag del
  guard, warning nueva
- `src/infrastructure/adapters/twilio/TwilioCreditBalanceGateway.ts` — `fresh` + `invalidate`
- `src/infrastructure/adapters/in-memory/InMemoryCreditBalancePort.ts` — twin real
- `src/infrastructure/adapters/prisma/PrismaMessagingRatesConfigRepository.ts` — sin fallback
- `src/infrastructure/http/app.ts` — UNA instancia compartida
- `prisma/migrations/20261113000000_messaging_rates_config/migration.sql` — seed del flag

Tests: `asyncMutex.test.ts` (nuevo) + `TwilioCreditBalanceGateway`, `InMemoryCreditBalancePort`,
`EstimateMessagingCost`, `SetMessagingRatesConfig`, `PrismaMessagingRatesConfigRepository`,
`PrismaExternalBulkPreviewRepository`, `InMemoryExternalBulkPreviewRepository`, `GetMessagingCredit`,
`SendExternalBulk`, `ValidateExternalBulk`, `external-messaging.routes`,
`messaging-rates-config.routes`, `twilio-credit-guard-composition`.

Artefactos SDD: `design.md` (D4.c, D5.d nuevo, D10.a revisado, D10.b/h/i),
`specs/messaging-credit-guard/spec.md` (CG-SEND-1 reescrito, CG-SEND-6, CG-AUTH-2, CG-FLAG-1,
CG-WIRE-1).

## Lo que el FE / la skill TIENEN que saber

1. **`credit.unitCost` y `credit.estimatedCost` pueden venir `null`** en el 200 de
   `POST /api/external/v1/messaging/bulk/validate` (y en el snapshot persistido). Formatear sin
   asumir string. `available` ya era nullable.
2. **Warning nueva `CREDIT_GUARD_DISABLED`** en `warnings[]` — significa "no se midió", distinto de
   `CREDIT_UNAVAILABLE` ("no se pudo medir").
3. **Feature flag nuevo `messaging-credit-guard-enabled`** (nace en `true`), operable con el
   `PATCH /api/admin/feature-flags/:key` que ya existe. **Cero pantalla nueva.**
4. `PUT /api/messaging/config/rates` ahora rechaza con **400** cualquier tarifa > `999999.9999`
   (antes era un 500). El mensaje del error nombra el tope y es mostrable tal cual.
