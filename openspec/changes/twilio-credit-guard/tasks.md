# Tasks — twilio-credit-guard

**Change**: twilio-credit-guard · **Phase**: tasks · **Repo BE**: este worktree
(`.claude\worktrees\twilio-credit-guard-be`). **Repo FE**: `ipnext-frontend`, worktree
`.claude\worktrees\twilio-credit-guard-fe` — Batch B4, DESPUÉS del BE.
**TDD estricto**: RED → GREEN → refactor. Adapters in-memory para use cases
(`InMemoryCreditBalancePort`, `InMemoryMessagingRatesConfigRepository`), JAMÁS mockear Prisma ni
axios real (inyectar `AxiosInstance` fake, molde `SmartOltHttpGateway`).
**Dependencias entre batches**: B1 (schema+dominio+ports+adapters+gateway Twilio) → B2
(`estimateMessagingCost` + `ValidateExternalBulk` extendido + config use cases, depende de B1) → B3
(`SendExternalBulk` gate + rutas + `app.ts` wiring, depende de B2) → B4 (FE, depende del contrato
de B3). Cada batch cierra con `npm test` + `npx tsc --noEmit` verdes antes de pasar al siguiente —
**no** `npm run build` (regla del repo).
**Matriz spec↔test**: cada task cita el requirement ID (`messaging-credit-guard` o el delta de
`external-bulk-messaging`) que cubre, para que `sdd-verify` arme la matriz de cobertura 1:1.
**Riesgos a vigilar** (D10 del design): el crédito NUNCA entra al `payloadHash` (CG-VAL-2); el gate
de `send` corre ANTES de `CreateCampaign`/`markConsumed` (CG-SEND-2/3, D4.c); el replay NO llama
`getBalance()` (CG-SEND-4); `details` del 422 se arma EN LA RUTA, el `errorHandler` global no
serializa campos extra (D3.d).

---

## Batch 1 — Schema + dominio + ports + adapters in-memory/Prisma + gateway Twilio (D1-D3)

- [x] **1.1** Migración `npx prisma migrate diff --from-migrations prisma/migrations
  --to-schema-datamodel prisma/schema.prisma --script` (sin editar SQL a mano, D1.d): `CREATE TABLE
  "MessagingRatesConfig"` (D1.a, singleton `id='singleton'`, 4 `Decimal(10,4)` con sus defaults) +
  `ALTER TABLE "ExternalBulkPreview" ADD COLUMN "credit" JSONB` (D1.b, nullable, sin backfill). Sin
  `BEGIN`/`COMMIT` (Prisma 7 los inyecta). Timestamp posterior al último existente en
  `prisma/migrations/`. Test: N/A (schema), verificado por 1.4/1.5.
- [x] **1.2** `prisma/schema.prisma`: modelo `MessagingRatesConfig` pegado a
  `ExternalBulkMessagingConfig` (~línea 4279, D1.a) tal cual; `ExternalBulkPreview.credit Json?`
  (D1.b). `npx prisma generate` limpio.
- [x] **1.3** RED+GREEN `src/domain/services/fixedPointMoney.ts` (NEW, puro, molde
  `bulkRecipientAuthorization.ts`) + `src/__tests__/domain/fixedPointMoney.test.ts` (D2):
  `parseMoney('17.894')===178940`; `'0.0618'`×500 = `'30.9000'` EXACTO; half-up
  (`'0.00005'`→1, `'0.00004'`→0); negativos; `tryParseMoney` devuelve `null` (no tira) para
  `''`/`'1e3'`/`'NaN'`/`'1,5'`/`null`/`Infinity`; `parseMoney` SÍ tira `MoneyParseError` para esos
  mismos casos; `formatMoney` siempre 4 decimales; round-trip `format(parse(x))===x` para
  4-decimales; `multiplyMoneyByCount` con `count` no entero o negativo tira; `Number.isSafeInteger`
  se verifica al salir (BAL-2, COST-3).
- [x] **1.4** `src/domain/errors/external-bulk-messaging.ts` (MOD, molde `ReporterUnavailableError`
  / `CapExceededError`, D3.d): `InsufficientCreditError` (`code:'INSUFFICIENT_CREDIT'`, campos
  `available/estimatedCost/currency`) + `CreditUnavailableError` (`code:'CREDIT_UNAVAILABLE'`).
  `src/infrastructure/http/middleware/errorHandler.ts` — 2 entradas nuevas en el `statusMap`
  (`INSUFFICIENT_CREDIT: 422`, `CREDIT_UNAVAILABLE: 503`, junto a `REPORTER_UNAVAILABLE` ~línea
  270). Test: cubierto por B2/B3 (sin test standalone, mismo criterio que los errores existentes).
- [x] **1.5** `src/domain/ports/CreditBalancePort.ts` (NEW, D3.a — port segregado ISP,
  `InMemoryTemplateMessagingGateway` NO se toca): `CreditBalance {amount, currency, fetchedAt,
  cached}` + `CreditBalancePort.getBalance(): Promise<CreditBalance>` (throws
  `CreditUnavailableError`, nunca un `amount` dudoso). `src/domain/ports/
  MessagingRatesConfigRepository.ts` (NEW, D3.b, molde `ExternalBulkMessagingConfigRepository`):
  `MessagingRatesConfig {currency, utilityRate, marketingRate, authenticationRate, providerFee,
  updatedAt}` (todas `string`, D2) + `MESSAGING_RATES_CONFIG_DEFAULTS` + `get()`/`set(patch)`.
- [x] **1.6** RED+GREEN `src/infrastructure/adapters/in-memory/InMemoryCreditBalancePort.ts` (NEW,
  D3.c) + test: `amount='17.8940'`, `currency='USD'`, `fetchedAt` seteables; `failNext=true` ⇒ tira
  `CreditUnavailableError`; contador público `calls` (para pinear "una sola request"/"replay no
  llama getBalance" en B3, CG-SEND-4). `src/infrastructure/adapters/in-memory/
  InMemoryMessagingRatesConfigRepository.ts` (NEW) + test: `get()` sin fila previa → 5 defaults
  (RATES-1); `set()` persiste y `get()` posterior refleja el patch + `updatedAt` actualizado.
- [x] **1.7** RED+GREEN `src/infrastructure/adapters/prisma/PrismaMessagingRatesConfigRepository.ts`
  (NEW, clon 1:1 del par de `ExternalBulkMessagingConfig`, D3.c — **incluido el fix F14: no
  fabricar `updatedAt` sin fila**) + test: mismos casos que 1.6 sobre Prisma; `Decimal` ↔ **string**
  en la frontera (`row.utilityRate.toFixed(4)` al leer, string tal cual al escribir, D2 — nunca
  `Number(row.rate)`).
- [x] **1.8** RED — `src/infrastructure/adapters/twilio/TwilioCreditBalanceGateway.ts` (NEW, clase
  propia, `axios` propio, NO extiende `TwilioContentGateway`, D3.c) +
  `src/__tests__/infrastructure/TwilioCreditBalanceGateway.test.ts` con `AxiosInstance` fake
  inyectado (JAMÁS axios/nock real, regla TDD del repo):
  - 200 con el body REAL de prod (`{"balance":"17.894","currency":"USD"}`) → `{amount:'17.8940',
    currency:'USD', cached:false}` (BAL-1, BAL-2).
  - 401/403/404/429/500/timeout/error de red/JSON basura/`balance:'abc'`/`currency` vacía →
    `CreditUnavailableError` en TODOS los casos (BAL-4, D3.c "todo es CreditUnavailableError").
  - **cache single-slot** (BAL-3): 2 llamadas dentro de 60s con reloj inyectable (`now: () =>
    number`, molde `SmartOltHttpGateway`) ⇒ 1 sola request HTTP + `cached:true` en la 2ª; reloj
    +60_001ms ⇒ dispara 2ª request.
  - **el error NO se cachea**: falla, luego éxito ⇒ 2 requests (D3.c).
  - URL exacta `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Balance.json` + Basic auth
    `{username: accountSid, password: authToken}` asserteados (mismo shape que
    `TwilioContentGateway.auth()`).
- [x] **1.9** GREEN — implementación de `TwilioCreditBalanceGateway` siguiendo D3.c: opciones
  `{accountSid, authToken, apiBaseUrl?, http?, timeoutMs=10_000, now=Date.now, cacheTtlMs=60_000}`.
- [x] **Gate B1**: `npx prisma generate` limpio; suites 1.3, 1.6-1.8 verdes; `npx tsc --noEmit`
  limpio (ports nuevos no rompen implementores existentes).

## Batch 2 — `estimateMessagingCost` + `ValidateExternalBulk` extendido + config use cases (D4.a, D4.b, D4.e)

- [x] **2.1** RED — `src/application/use-cases/messaging/EstimateMessagingCost.ts` (NEW, módulo
  PURO, molde `externalBulkPayloadHash.ts`) + `src/__tests__/application/messaging/
  EstimateMessagingCost.test.ts` (COST-1..4, D4.a):
  - las 3 categorías (`UTILITY`/`MARKETING`/`AUTHENTICATION`) → `unitCost = rate + providerFee`
    exacto con defaults (`UTILITY`: `0.0170`).
  - `category` `undefined`/`'promocional'` (desconocida) ⇒ tarifa MARKETING +
    `categoryAssumed:true` (COST-2).
  - `balance:null` ⇒ `unknown:true`, `available:null`, `sufficient:false` (COST-4).
  - **moneda del balance ≠ la de `rates` ⇒ `unknown:true`, NUNCA una comparación a ciegas** (COST-4).
  - tarifa ilegible en la fila (`tryParseMoney` da `null`) ⇒ `unknown:true`, NUNCA se trata como `0`
    (memoria *basura-al-valor-SEGURO-no-al-default*).
  - borde `estimatedCost === available` ⇒ `sufficient:true` (`>=`, COST-4 scenario "límite exacto").
  - lote de 500 sin arrastre de punto flotante: `validCount=500`, `unitCost='0.0170'` ⇒
    `estimatedCost='8.5000'` determinístico (COST-3).
- [x] **2.2** GREEN — implementación de `estimateMessagingCost` siguiendo D4.a paso a paso
  (`normalizeCategory` → `unitCostMicro` → `estimatedCostMicro` → chequeo de moneda → `sufficient`),
  totalmente pura, nunca tira.
- [x] **2.3** RED — `src/application/use-cases/messaging/GetMessagingRatesConfig.ts` +
  `SetMessagingRatesConfig.ts` (NEW, clon 1:1 de `GetExternalBulkConfig`/`SetExternalBulkConfig`,
  D4.e) + tests: `Get` delega en `ratesRepo.get()` (defaults si no hay fila, RATES-1); `Set` recibe
  `unknown` y rechaza con `ExternalBulkValidationError` (código `VALIDATION_ERROR`) cuando alguna
  tarifa no matchea `DECIMAL_4_RE = /^\d+(\.\d{1,4})?$/` (negativa, >4 decimales, `number` en vez de
  `string`) o `currency` no matchea `CURRENCY_RE = /^[A-Z]{3}$/` — config NO se persiste (RATES-2);
  válido → normaliza con `formatMoney(parseMoney(x))` antes de persistir y `get()` posterior refleja
  el patch.
- [x] **2.4** GREEN — implementación de `GetMessagingRatesConfig`/`SetMessagingRatesConfig` (D4.e).
- [x] **2.5** RED — `src/application/dto/external-bulk-messaging.dto.ts` (MOD):
  `ValidateExternalBulkOutput` suma `credit: MessagingCreditDto` + `warnings?:
  ExternalBulkWarning[]` (`'INSUFFICIENT_CREDIT' | 'CREDIT_UNAVAILABLE'`, VAL-9/CG-VAL-1) +
  extensión de `ValidateExternalBulk.test.ts` (MOD):
  - `credit` viaja en la respuesta 200 con `{available, currency, category, unitCost,
    estimatedCost, sufficient}` (CG-VAL-1).
  - insuficiente ⇒ **200** (NUNCA 4xx) + `warnings:['INSUFFICIENT_CREDIT']` (CG-VAL-1).
  - `creditPort.getBalance()` lanza ⇒ **200** + `credit.unknown:true` +
    `warnings:['CREDIT_UNAVAILABLE']` — el `try/catch` de `resolveCredit` degrada, JAMÁS voltea el
    request (D4.b).
  - `ratesRepo.get()` lanza ⇒ usa `MESSAGING_RATES_CONFIG_DEFAULTS` como fallback, no rompe
    `validate` (D4.b).
  - `credit` viaja TAMBIÉN al snapshot persistido: `previewRepo.create({..., credit})` recibe el
    mismo objeto que la respuesta (CG-VAL-2).
  - **`payloadHash` IDÉNTICO al valor de antes del change** (literal hardcodeado del test previo a
    este change) — el crédito NO participa del hash aunque las tarifas cambien entre 2 previews del
    MISMO payload (CG-VAL-2, no-regresión OBLIGATORIA).
  - `warnings` AUSENTE (no array vacío) cuando `sufficient:true` y `unknown` ausente.
- [x] **2.6** GREEN — `ValidateExternalBulk.ts` (MOD): 2 dependencias nuevas al constructor
  (`creditPort: CreditBalancePort`, `ratesRepo: MessagingRatesConfigRepository`), inyectadas ANTES
  del `now` con default, quedando 11 (D4.b exacto). Bloque `9.5 — CRÉDITO` insertado DESPUÉS del
  cierre de los caps (`CapExceededError` de `perDay`) y ANTES del comentario de persist preview
  (D4.b, punto de inserción exacto). Método privado `resolveCredit(category, validCount)` con los
  `try/catch` de degradación (rates → defaults, balance → `null`). `credit` se suma a la entidad
  `ExternalBulkPreview` y a `ExternalBulkPreviewCreateData`.
- [x] **Gate B2**: suites 1.3(reused)/2.1/2.3/2.5 verdes, matriz COST-1..4, RATES-1/2, CG-VAL-1/2
  cubierta 1:1; `npx tsc --noEmit` limpio.
  - **Nota de scope**: además de lo listado en Batch 2, se implementó `GetMessagingCredit`
    (formalmente task 3.3 de Batch 3, D4.d) DENTRO de este batch — instrucción explícita del
    orquestador en el prompt de arranque de B2. `SendExternalBulk`/rutas/`app.ts` completo (resto
    de 3.x) siguen pendientes para B3.

## Batch 3 — `SendExternalBulk` gate + rutas `GET /credit` + config admin + `app.ts` wiring (D4.c, D4.d, D5, D6)

- [x] **3.1** RED — extensión de `SendExternalBulk.test.ts` (MOD, D4.c, CG-SEND-1..4):
  - **orden vs caps/template**: cap excedido Y sin crédito ⇒ `CAP_EXCEEDED` (el crédito nunca
    corre); template no aprobado Y sin crédito ⇒ `TEMPLATE_NOT_APPROVED` — crédito es el ÚLTIMO
    guard antes de `CreateCampaign` (regla de oro D0, pineado por test).
  - insuficiente ⇒ `InsufficientCreditError`, **cero `Campaign` creada, preview `consumedAt:null`**
    (CG-SEND-2) — el chequeo corre ANTES de `CreateCampaign`/`markConsumed`.
  - balance inalcanzable (`getBalance()` lanza) ⇒ `CreditUnavailableError`, cero `Campaign`
    (CG-SEND-3).
  - moneda del balance ≠ la de `rates` ⇒ `CreditUnavailableError`, cero `Campaign` (CG-SEND-3).
  - opt-out entre `validate` y `send` reduce el `validCount` re-chequeado (9 en vez de 10, CG-SEND-1
    — usa `preview.recipients.length` REAL, no el snapshot).
  - **replay** (misma `Idempotency-Key`, campaña ya creada) ⇒ `creditPort.calls === 0` — NO
    re-chequea crédito, camino de replay NO TOCADO (CG-SEND-4, usa el contador de 1.6).
  - tarifas en `0` ⇒ `estimatedCost='0.0000'`, `sufficient` siempre `true`, guard nunca rechaza
    (CG-SEND-5, rollback operativo).
- [x] **3.2** GREEN — `SendExternalBulk.ts` (MOD): 2 dependencias nuevas al constructor (mismas 2
  instancias que `ValidateExternalBulk`, D4.c), quedando 12. Método privado
  `assertSufficientCredit(category, count)` insertado ENTRE el cierre de la re-validación de SEND-4
  (cap `remainingToday`) y el comentario de `CreateCampaign` (D4.c, punto de inserción exacto): si
  `ratesRepo.get()` revienta, sube (no se adivina); `getBalance()` lanza ⇒
  `throw CreditUnavailableError()`; `credit.unknown` ⇒ `CreditUnavailableError`; `!credit.sufficient`
  ⇒ `InsufficientCreditError({available, estimatedCost, currency})`. El método `private async
  replay(...)` NO se toca — ni una línea (D4.c, mismo criterio que caps en replay).
- [x] **3.3** RED+GREEN `src/application/use-cases/messaging/GetMessagingCredit.ts` (NEW, D4.d) +
  test: `execute()` combina `creditPort.getBalance()` + `ratesRepo.get()` →
  `{available, currency, fetchedAt, cached, rates:{...}}`; `getBalance()` lanza ⇒ propaga
  `CreditUnavailableError` (acá SÍ es un error — CRED-1, CRED-2).
  **Adelantada a B2** (instrucción explícita del orquestador) — 3/3 tests verdes, `Promise.all`
  balance+rates. Sin wiring todavía (eso sigue siendo B3: `app.ts`, `GET /credit`, router de config).
- [x] **3.4** RED — `src/infrastructure/http/routes/external-messaging.routes.ts` (MOD, D5.a) +
  extensión de `external-messaging.routes.test.ts`:
  - `GET /credit` (ruta hermana, ANTES del catch-all, sin `writeRateLimiter` — es lectura) → 200
    `{available, currency, fetchedAt, cached, rates:{...}}` (CRED-1); 503 `CREDIT_UNAVAILABLE` si
    `getMessagingCredit.execute()` lanza (CRED-2); 403 `FEATURE_DISABLED` con flag OFF, SIN llamar a
    Twilio; 401 sin key dedicada; 401 con la key GLOBAL (CG-AUTH-1).
  - `POST /send` con `InsufficientCreditError` ⇒ 422 con `details:{available, estimatedCost,
    currency}` armado EN LA RUTA (D5.b, el `errorHandler` no serializa campos extra — D3.d); con
    `CreditUnavailableError` ⇒ 503 (solo `{error,code}` del `statusMap`, sin bloque extra).
  - `POST /validate` con crédito insuficiente/inalcanzable ⇒ 200 con `warnings` en el body
    (integración de 2.5 vía HTTP).
- [x] **3.5** GREEN — router: handler `GET /credit` (D5.a) + bloque `if (err instanceof
  InsufficientCreditError)` en el catch de `/send` (D5.b, junto al de `CampaignRunnerBusyError`
  existente). `ExternalMessagingRouterDeps` suma `getMessagingCredit: GetMessagingCredit`.
- [x] **3.6** RED+GREEN `src/infrastructure/http/routes/messaging-rates-config.routes.ts` (NEW,
  kebab-case, D5.c) + `src/__tests__/infrastructure/messaging-rates-config.routes.test.ts`: `GET /`
  gate `messaging:read` (403 sin el permiso, RATES-3); `PUT /` gate `messaging:manage` (403 con solo
  `messaging:read`, config no cambia, RATES-3); `PUT` con `{utilityRate:-0.01}` /
  `{marketingRate:0.06185}` / `{currency:'usd'}` / `number` en vez de string ⇒ 400
  `VALIDATION_ERROR`, no persiste (RATES-2); `PUT` válido → 200 FLAT (sin envelope) con las 5
  tarifas + `updatedAt`; `GET /balance` (D5.c, alimenta la card FE) → 200
  `{available, currency, fetchedAt, cached}` (SIN el bloque `rates`) / 503 `CREDIT_UNAVAILABLE`.
- [x] **3.7** RED — `src/__tests__/infrastructure/twilio-credit-guard-composition.test.ts` (NEW,
  molde `external-bulk-messaging-composition.test.ts`, D6, D10.g) — scan de fuente de `app.ts`:
  - el mount de `/api/messaging/config/rates` existe.
  - `ValidateExternalBulk`/`SendExternalBulk` reciben `TwilioCreditBalanceGateway` +
    `PrismaMessagingRatesConfigRepository` como argumentos (grep de fuente).
  - **la MISMA instancia** de `creditBalancePort` se pasa a `ValidateExternalBulk` y a
    `SendExternalBulk` (assert de identidad de variable en el fuente, D6 "un validate seguido de un
    send no le pega dos veces a Twilio").
  - el marcador `[external-bulk-mount-end]` (`app.ts:3658`) sigue presente sin modificar.
- [x] **3.8** GREEN — `app.ts` (MOD, D6): bloque self-contained entre la línea del
  `externalBulkConfigRepo` existente y su `app.use(...)` — `creditBalancePort = new
  TwilioCreditBalanceGateway({accountSid: config.twilio.accountSid, authToken:
  config.twilio.authToken})` + `messagingRatesRepo = new PrismaMessagingRatesConfigRepository()`,
  pasados a `ValidateExternalBulk`/`SendExternalBulk` y a
  `getMessagingCredit: new GetMessagingCredit(creditBalancePort, messagingRatesRepo)`. Bloque nuevo
  separado (instancias PROPIAS, D6) que monta `messaging-rates-config.routes.ts` con su propio
  `PrismaMessagingRatesConfigRepository` + `TwilioCreditBalanceGateway`. Sin env vars nuevas.
- [x] **Gate B3**: `npm test` completo del BE verde (incluye B1-B3); `npx tsc --noEmit` limpio. NO
  `npm run build`. (`Test Suites: 6 skipped, 1265 passed, 1271 total` ·
  `Tests: 88 skipped, 13198 passed, 13286 total`, exit 0.)

## Batch 4 — FE: `MessagingRatesCard` en Config → WhatsApp (repo `ipnext-frontend`, worktree
`twilio-credit-guard-fe`, D8, cambio coordinado)

- [x] **4.1** `types/messagingRatesConfig.ts` (NEW): tipos espejo campo-a-campo del contrato D5.c —
  `MessagingRatesConfig {currency, utilityRate, marketingRate, authenticationRate, providerFee,
  updatedAt: string}` (todos `string`, NUNCA `number` — D8) + `MessagingCreditBalance {available,
  currency, fetchedAt, cached}`.
  *(sdd-verify, 2026-09-03: implementado como `src/types/messagingRates.ts` en el worktree FE — nombre
  de archivo distinto al literal de la task, contrato idéntico; confirmado vía engram #2528/#2529 +
  `git log`/`git status` del worktree FE, commit `1f0944c3`.)*
- [x] **4.2** RED+GREEN `hooks/useMessagingRatesConfig.ts` (molde `useExternalBulkMessagingConfig`,
  React Query): `GET/PUT /api/messaging/config/rates` + `GET /api/messaging/config/rates/balance`
  (fetch paralelo al mount, D8). Test: hook devuelve el shape desenvuelto; `PUT` invalida la query
  tras éxito; el fetch de balance es independiente del de tarifas (un 503 de balance no rompe el
  form de tarifas).
  *(sdd-verify, 2026-09-03: `src/hooks/useMessagingRatesConfig.ts` + `src/api/messagingRatesConfig.api.ts`
  + tests presentes en el worktree FE, confirmado por engram.)*
- [x] **4.3** RED+GREEN `components/settings/MessagingRatesCard.tsx` (NEW, molde EXACTO
  `ExternalBulkMessagingCard.tsx`, hermana no extensión — 2 configs, 2 permisos), montada en
  `WhatsappSettingsPage.tsx` junto a `ExternalBulkMessagingCard`:
  - 5 inputs controlados (`currency` + las 4 tarifas) con regex `/^\d+(\.\d{1,4})?$/` para tarifas y
    `/^[A-Z]{3}$/` + `toUpperCase()` al tipear para `currency` (D8 — **`STRICT_INTEGER_RE` de la
    card vecina NO sirve**, son decimales). Se manda **string** al `PUT`, nunca `Number(input)`.
  - bloque de saldo: "Saldo Twilio: **{available} {currency}**" + "hace N s" + badge cuando
    `cached`; un 503 del balance muestra "Saldo no disponible" SIN romper la edición de tarifas
    (D8, estado independiente).
  - 4 estados de fetch (molde de la card vecina): `loading` (skeleton), `error` (banner + reintentar),
    `ok`, `saving` (inputs/botón disabled).
  - **confirm al guardar** (`window.confirm` o modal del design system): "Estas tarifas gobiernan el
    bloqueo de envíos masivos. ¿Confirmás?" (D8 — poner las 4 en 0 desactiva el guard).
  - gate `messaging:manage` para editar (sin el permiso: read-only, no oculto, molde
    `ExternalBulkMessagingCard`); `messaging:read` para ver.
  - test: submit con tarifa que no matchea la regex deshabilita el botón ANTES de llamar al hook;
    error 400 del BE (mockeado) se muestra igual si el cliente no lo atrapó.
  *(sdd-verify, 2026-09-03: implementado + fix wave adversarial de 14 findings aplicado (engram #2528,
  bugfix), full-rewrite de `MessagingRatesCard.tsx`/`.test.tsx`. Commit `1f0944c3` en el worktree FE.)*
- [x] **4.4** Tests Vitest de accesibilidad: los 5 inputs con `label` asociado; banner de error con
  rol `alert`; foco visible en el botón "Guardar" tras error (molde 5.4 de `external-bulk-messaging`).
  *(sdd-verify, 2026-09-03: cubierto dentro de `MessagingRatesCard.test.tsx` (42 tests) + ajustes en
  `WhatsappSettingsPage.test.tsx`, engram #2528.)*
- [x] **Gate B4**: suite Vitest de `MessagingRatesCard` + `useMessagingRatesConfig` verde;
  lint/typecheck del FE limpio.
  *(sdd-verify, 2026-09-03: gate reportado por el orquestador — vitest 7995 passed (engram #2528 dice
  7993/1 pre-existing fail/1 todo, consistente), build limpio (21.75s), `npx tsc`/typecheck limpio.
  Única falla es la pre-existing `WhatsappReportsPage` NO relacionada a este change.)*

## Batch F (reservado) — Fix wave post-review adversarial

Sin tasks pre-definidas — se completa tras el review adversarial de B1-B4, molde
`external-bulk-messaging` Batch F (severidad ALTO/MEDIO/LOW por finding).

---

## Post-deploy (no-código, runbook del operador/orquestador)

- [ ] **P.1** Smoke en vivo: `GET /api/external/v1/messaging/bulk/credit` (key dedicada) → verificar
  `available`/`currency`/`rates` contra el saldo real (D0.b verificado 2026-09-03: 17.894 USD).
- [ ] **P.2** `validate` con un batch chico → confirmar `credit.estimatedCost`/`sufficient` a ojo
  contra el cálculo manual (categoría del template real).
- [ ] **P.3** Forzar un `send` con 422: subir temporalmente `marketingRate` a un valor alto desde
  `PUT /api/messaging/config/rates` → `send` de un lote MARKETING → confirmar 422
  `INSUFFICIENT_CREDIT` con `details` correctos y CERO `Campaign` creada → **volver las 4 tarifas a
  los defaults** (`0.0120/0.0618/0.0220/0.0050`) antes de cerrar la verificación.
- [ ] **P.4** Recién con eso verde: sección "Crédito" en la skill `whatsapp-bulk-ipnext` (fuera de
  este change — se escribe DESPUÉS de la verificación en vivo, molde P.5 de `external-bulk-messaging`).
- [ ] **P.5** Card en BACKLOG.md documentando el rollout (D9 del design): día 1 con saldo actual +
  MARKETING el techo por lote es ~267 mensajes — avisar antes, no descubrirlo en la 1ª campaña.
- [ ] **P.6** `sdd-archive` del change una vez P.1-P.5 completos.

---

## Riesgos / desvíos a vigilar en `sdd-apply` (heredados del design, D10)

- **El crédito NUNCA entra al `payloadHash`** (2.5/2.6, CG-VAL-2) — si un fix wave toca
  `externalBulkPayloadHash.ts` o el orden de campos en `ValidateExternalBulk`, el test de
  no-regresión del hash (literal hardcodeado) es el único que lo detecta.
- **Orden del gate de crédito en `send` es LOAD-BEARING** (3.1/3.2, D0 "regla de oro del orden") —
  crédito SIEMPRE después de caps/template, SIEMPRE antes de `CreateCampaign`/`markConsumed`. Un
  desvío rompe CG-SEND-2 en runtime sin que el middleware aislado lo detecte.
- **Replay no re-chequea crédito** (3.1, CG-SEND-4) — el contador `calls` de
  `InMemoryCreditBalancePort` (1.6) es el mecanismo de pin; si `replay()` se refactoriza, no debe
  empezar a llamar `getBalance()`.
- **`details` del 422 se arma en la ruta, no en el `errorHandler`** (3.4/3.5, D3.d) — un refactor
  del error handling global que intente "centralizar" el 422 de crédito rompe el contrato de wire
  (`{available, estimatedCost, currency}`).
- **Cache de 60s es de DOS slots independientes** (validate/send comparten instancia vía D6; el
  router de config admin tiene su PROPIA instancia, D6/D10.g) — no asumir que un `PUT` de tarifas
  invalida la cache de balance del bloque bulk, son cosas distintas (balance vs tarifas).
- **`app.ts` como punto de colisión** (3.7/3.8, D10.g) — bloque self-contained; el test de
  composition-root (3.7) es el que detecta un mount fuera de lugar o una instancia compartida
  accidentalmente entre bloques que deberían ser independientes.
