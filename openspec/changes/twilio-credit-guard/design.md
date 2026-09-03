# Design — twilio-credit-guard (saldo Twilio + costo estimado del lote antes de autorizar)

> Molde de este documento: `openspec/changes/archive/2026-09-02-external-bulk-messaging/design.md`.
> Todo lo de acá es ADITIVO sobre esa capability: ningún requirement existente cambia de semántica,
> y el `payloadHash` no se toca (pineado por test, D1.c).
>
> **Hecho verificado en vivo (2026-09-03, desde el contenedor de prod)**:
> `GET https://api.twilio.com/2010-04-01/Accounts/{sid}/Balance.json` con las MISMAS
> `config.twilio.accountSid`/`authToken` → `HTTP 200 {"balance":"17.894","currency":"USD"}`.
> El balance es un **string** con 3 decimales (no un número, no 4 decimales) — todo el
> parseo de D2 nace de ese hecho, no de una suposición.

---

## D0 — Mapa del flujo (dónde cae cada pieza)

```
POST /api/external/v1/messaging/bulk/validate      (key dedicada + kill-switch)
  ValidateExternalBulk.execute()
    1 flag · 2 shape · 3 config · 4 template(→category) · 5 recipients · 6 label
    7 merge+render · 8 EMPTY · 9 caps (perRequest, perDay)
    9.5 ── CRÉDITO (ADVISORY, nunca tira) ────────────────────────────┐
           ratesRepo.get() ─┐                                        │
           creditPort.getBalance() ─┴─→ estimateMessagingCost() ──────┤
    10 persist preview (+ credit snapshot, FUERA del payloadHash) ←───┘
    → 200 { …, credit, warnings? }

POST /api/external/v1/messaging/bulk/send          (key dedicada + kill-switch)
  SendExternalBulk.execute()
    0 shape · 0.5 GUARD-0 → replay ⇒ SALE ACÁ (crédito NO se re-chequea)
    1 flag · 2 preview · 3 re-hash · 4 template/label/caps
    4.5 ── CRÉDITO (GATE, fail-closed) ──────────────────────────────┐
           balance fresco + rates + recipients de AHORA              │
           insuficiente ⇒ 422 · inalcanzable/moneda ≠ ⇒ 503          │
    5 CreateCampaign · 6 markConsumed · 7 runner.start ←──────────────┘

GET /api/external/v1/messaging/bulk/credit         (key dedicada + kill-switch, solo lectura)
GET /api/messaging/config/rates                    (sesión, messaging:read)
GET /api/messaging/config/rates/balance            (sesión, messaging:read)   ← la card FE
PUT /api/messaging/config/rates                    (sesión, messaging:manage)
```

**Regla de oro del orden**: el crédito corre SIEMPRE **después** de los caps de cantidad. Los caps
son baratos (memoria + una query) y su error es más específico; el crédito toca la red. Un lote que
excede `maxPerRequest` debe devolver `CAP_EXCEEDED`, no `INSUFFICIENT_CREDIT` — está pineado por
test (D7, "ordering vs caps").

---

## D1 — Data model: 1 tabla nueva + 1 columna, todo aditivo

### D1.a — `MessagingRatesConfig` (NEW, singleton — molde EXACTO `ExternalBulkMessagingConfig`)

```prisma
// prisma/schema.prisma — pegado a ExternalBulkMessagingConfig (~línea 4279)
model MessagingRatesConfig {
  id                 String   @id @default("singleton")
  currency           String   @default("USD")            // ISO-4217, 3 letras MAYÚSCULAS
  utilityRate        Decimal  @default(0.0120) @db.Decimal(10, 4)
  marketingRate      Decimal  @default(0.0618) @db.Decimal(10, 4)
  authenticationRate Decimal  @default(0.0220) @db.Decimal(10, 4)
  providerFee        Decimal  @default(0.0050) @db.Decimal(10, 4)  // fee Twilio por mensaje
  updatedAt          DateTime @updatedAt
}
```

`Decimal(10,4)` sigue la convención de plata del repo (nunca `Float`, ver "Money handling" de la
exploración). Los 4 defaults son los del ask, sembrados por la migración **y** repetidos en código
(`MESSAGING_RATES_CONFIG_DEFAULTS`, D3.b) — mismo criterio doble de `EXTERNAL_BULK_MESSAGING_CONFIG_DEFAULTS`.

### D1.b — `ExternalBulkPreview.credit Json?` (MOD)

```prisma
model ExternalBulkPreview {
  …
  credit Json?   // snapshot ADVISORY de lo que se le mostró al que autorizó (D4.d).
                 // FUERA del payloadHash (D1.c). Nullable: previews vivos siguen válidos.
}
```

### D1.c — El crédito NO entra al `payloadHash`

`externalBulkPayloadHash` se computa SOLO sobre lo que el CALLER controla (`templateName`,
`variables`, `chatwootLabel`, `recipients`). El balance es dato del PROVEEDOR: el de las 15:00 no es
el de las 15:05, y meterlo rompería la re-hasheabilidad determinística de SEND-3
(`assertPayloadUnchanged`, `SendExternalBulk.ts:327-340`). **Test de no-regresión obligatorio**: el
hash de un preview fijo es byte-idéntico antes y después de este change.

### D1.d — Migración

Una sola, aditiva, **sin `BEGIN`/`COMMIT`** (Prisma 7 los inyecta):
`prisma/migrations/2026<fecha>_messaging_rates_config/migration.sql` generada con
`npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script`
(jamás SQL a mano). Contenido esperado: `CREATE TABLE "MessagingRatesConfig"` + `ALTER TABLE
"ExternalBulkPreview" ADD COLUMN "credit" JSONB`. Sin FK, sin backfill, sin índice.

---

## D2 — Aritmética de plata: punto fijo, cero `Number` flotante en el camino de decisión

**Módulo puro nuevo**: `src/domain/services/fixedPointMoney.ts` (molde de ubicación:
`src/domain/services/bulkRecipientAuthorization.ts` — servicio de dominio sin dependencias).

```ts
/** Enteros de 1/10000 de unidad monetaria. SIEMPRE Number.isSafeInteger. */
export type Micro = number;
export const MONEY_SCALE = 10_000;
export const MONEY_DECIMALS = 4;

export class MoneyParseError extends Error {}

/** '17.894' → 178940 · '0.06185' → 619 (half-up) · '-3' → -30000. Throws MoneyParseError. */
export function parseMoney(input: string): Micro;
/** Igual pero devuelve `null` en vez de tirar (para input no confiable del proveedor/config). */
export function tryParseMoney(input: unknown): Micro | null;
export function addMoney(a: Micro, b: Micro): Micro;
/** count DEBE ser entero >= 0 (validCount). Throws si no. */
export function multiplyMoneyByCount(m: Micro, count: number): Micro;
export function compareMoney(a: Micro, b: Micro): -1 | 0 | 1;
/** 178940 → '17.8940' — SIEMPRE 4 decimales, para mostrar/persistir. */
export function formatMoney(m: Micro): string;
```

**Cómo parsea (sin floats)**: valida `/^-?\d+(\.\d+)?$/` sobre el string trimeado (rechaza `''`,
`'1e3'`, `'NaN'`, `Infinity`, `null`, números con separador de miles). Parte en entero/fracción
como **strings**, paddea la fracción a 5 dígitos, aplica half-up mirando el 5º dígito, y arma el
resultado con `Number(intPart) * MONEY_SCALE ± Number(frac4)`. Un `number` de entrada (por si un
adapter lo pasa) se convierte primero con `String(n)` y pasa por el mismo camino. Verifica
`Number.isSafeInteger` al salir y tira si no (montos absurdos).

**Frontera con Prisma**: `Decimal` ↔ **string**, nunca `Number(row.rate)`. En el adapter:
`row.utilityRate.toFixed(4)` (decimal.js) al leer; al escribir se manda el string tal cual (Prisma
lo acepta como `Decimal`). El dominio (`MessagingRatesConfig`, D3.b) declara las tarifas como
`string`, no como `number` — **esta es la decisión que mata el riesgo de float en origen**: no hay
punto del flujo donde una tarifa exista como `Number` no entero.

**Por qué no `decimal.js` en el dominio**: el repo no lo usa en ningún use case (exploración), y el
problema acá es de dos operaciones (multiplicar por un entero, comparar) — 60 líneas puras y
testeables baten una dependencia nueva.

---

## D3 — Ports nuevos (2) y qué se REUSA sin tocar

### D3.a — `src/domain/ports/CreditBalancePort.ts` (NEW, segregado — ISP)

```ts
export interface CreditBalance {
  /** Punto fijo de 4 decimales, ej. '17.8940'. NUNCA number (D2). */
  amount: string;
  /** ISO-4217 en MAYÚSCULAS tal como lo informa el proveedor, ej. 'USD'. Passthrough: NO se convierte. */
  currency: string;
  fetchedAt: Date;
  /** true = servido del slot de cache, sin request HTTP nueva. */
  cached: boolean;
}

export interface CreditBalancePort {
  /** Throws `CreditUnavailableError` ante red/timeout/4xx/5xx/payload ilegible. NUNCA devuelve un amount dudoso. */
  getBalance(): Promise<CreditBalance>;
}
```

Port **segregado**: `InMemoryTemplateMessagingGateway` NO se toca — el fake de crédito no sabe nada
de templates (Approach 2 de la exploración, adoptada).

### D3.b — `src/domain/ports/MessagingRatesConfigRepository.ts` (NEW — molde `ExternalBulkMessagingConfigRepository`)

```ts
export interface MessagingRatesConfig {
  currency: string;            // 'USD'
  utilityRate: string;         // '0.0120' — string de 4 decimales, D2
  marketingRate: string;       // '0.0618'
  authenticationRate: string;  // '0.0220'
  providerFee: string;         // '0.0050'
  updatedAt: string;           // ISO
}
export const MESSAGING_RATES_CONFIG_DEFAULTS: Omit<MessagingRatesConfig, 'updatedAt'> = {
  currency: 'USD', utilityRate: '0.0120', marketingRate: '0.0618',
  authenticationRate: '0.0220', providerFee: '0.0050',
};
export type MessagingRatesConfigPatch = Omit<MessagingRatesConfig, 'updatedAt'>;
export interface MessagingRatesConfigRepository {
  get(): Promise<MessagingRatesConfig>;
  set(patch: MessagingRatesConfigPatch): Promise<MessagingRatesConfig>;
}
```

### D3.c — Adapters

| Archivo | Qué hace |
|---|---|
| `src/infrastructure/adapters/twilio/TwilioCreditBalanceGateway.ts` (NEW) | `CreditBalancePort` real (abajo) |
| `src/infrastructure/adapters/in-memory/InMemoryCreditBalancePort.ts` (NEW) | fake settable para tests |
| `src/infrastructure/adapters/prisma/PrismaMessagingRatesConfigRepository.ts` (NEW) | clon 1:1 del de external-bulk, **incluido el fix F14** |
| `src/infrastructure/adapters/in-memory/InMemoryMessagingRatesConfigRepository.ts` (NEW) | clon 1:1 |

**`TwilioCreditBalanceGateway`** — clase propia, `axios` propio, NO extiende ni toca
`TwilioContentGateway` (que ya implementa 2 ports):

```ts
export interface TwilioCreditBalanceGatewayOptions {
  accountSid: string;
  authToken: string;
  /** Default 'https://api.twilio.com' — el MISMO host de `sendTemplate` (TwilioContentGateway.ts:34). */
  apiBaseUrl?: string;
  /** Inyectable para tests — JAMÁS axios/nock real (regla TDD del repo). */
  http?: AxiosInstance;
  /** Default 10_000. Más corto que los 15s de templates: esto corre en el camino caliente del send. */
  timeoutMs?: number;
  /** Reloj inyectable — molde SmartOltHttpGateway.ts:28-52. Default Date.now. */
  now?: () => number;
  /** Default 60_000 — el MISMO número que las 3 caches de SmartOltHttpGateway. */
  cacheTtlMs?: number;
}

export class TwilioCreditBalanceGateway implements CreditBalancePort {
  private cache: { value: Omit<CreditBalance, 'cached'>; expiresAt: number } | null = null;
  async getBalance(): Promise<CreditBalance> { … }
}
```

- URL: `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Balance.json`, `{ auth: {username: accountSid,
  password: authToken}, timeout }` — el MISMO shape de `TwilioContentGateway.auth()` (`:84-86`).
- Respuesta: `{ balance: string, currency: string, account_sid: string }`. Se normaliza con
  `parseMoney(data.balance)` → `formatMoney(...)` (`'17.894'` → `'17.8940'`) y
  `String(data.currency).trim().toUpperCase()`.
- **Cache single-slot** (cardinalidad 1 — no hay `Map`, no hay key): hit si
  `cache && cache.expiresAt > this.now()` → `{...cache.value, cached: true}`. Miss → HTTP,
  se guarda `{value, expiresAt: now() + cacheTtlMs}` y se devuelve con `cached: false`.
- **Los errores NO se cachean**: un 500 momentáneo no debe bloquear 60 s de envíos.
- Mapeo de errores — deliberadamente **más simple** que `mapCrudError`
  (`TwilioContentGateway.ts:294-314`): acá **todo** (401, 403, 404, 429, 5xx, timeout, red, JSON
  ilegible, `balance` no parseable, `currency` vacía) es `CreditUnavailableError`. No hay semántica
  per-mensaje ni "recurso no encontrado" útil para un balance: o hay un número confiable o no lo hay.
- **La conversión de moneda NO existe**: `currency` es passthrough. La comparación contra la moneda
  de la config vive en el use case (D4.c), no acá.

**`InMemoryCreditBalancePort`**: `amount = '17.8940'`, `currency = 'USD'`, `fetchedAt`,
`cachedNext = false`, `failNext = false` (tira `CreditUnavailableError`), y contador público
`calls: number` (para pinear "una sola request").

### D3.d — Errores de dominio (MOD `src/domain/errors/external-bulk-messaging.ts`)

```ts
/** Solo lo tira `SendExternalBulk` (gate). En `validate` es un WARNING, jamás un error. */
export class InsufficientCreditError extends DomainError {
  public readonly available: string;
  public readonly estimatedCost: string;
  public readonly currency: string;
  constructor(d: { available: string; estimatedCost: string; currency: string }) {
    super(`Insufficient provider credit: ${d.estimatedCost} ${d.currency} needed, ${d.available} available`,
          'INSUFFICIENT_CREDIT');
    this.name = 'InsufficientCreditError'; …
  }
}
/** Molde `ReporterUnavailableError` — misconfiguración/indisponibilidad de plataforma, nunca error del caller. */
export class CreditUnavailableError extends DomainError {
  constructor(message = 'Provider credit balance is unavailable') {
    super(message, 'CREDIT_UNAVAILABLE');
    this.name = 'CreditUnavailableError';
  }
}
```

`src/infrastructure/http/middleware/errorHandler.ts` — 2 entradas nuevas en el `statusMap` del
bloque `external-bulk-messaging` (junto a `REPORTER_UNAVAILABLE: 503`, línea ~270):

```ts
  INSUFFICIENT_CREDIT: 422,
  CREDIT_UNAVAILABLE: 503,
```

**Gotcha verificado**: el `errorHandler` serializa SOLO `{error, code}` de un `DomainError` (línea
356) — los campos extra requieren un mapeo explícito. Igual que `CampaignRunnerBusyError`, el
`details` del 422 se agrega **en la ruta** (D5.b), no en el handler global.

---

## D4 — Use cases (application/, cero import de `@infrastructure/*`)

### D4.a — `src/application/use-cases/messaging/EstimateMessagingCost.ts` (NEW, módulo PURO)

Molde de "módulo puro dentro de use-cases": `externalBulkPayloadHash.ts`.

```ts
export type MessagingTemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

export interface MessagingCreditDto {
  /** Saldo del proveedor, 4 decimales. `null` cuando `unknown`. */
  available: string | null;
  currency: string;
  /** La categoría USADA para tarifar (nunca undefined — ver categoryAssumed). */
  category: MessagingTemplateCategory;
  /** Presente y `true` SOLO si la categoría del template faltaba/era desconocida ⇒ se tarifó MARKETING. */
  categoryAssumed?: true;
  /** tarifa de la categoría + providerFee, 4 decimales. */
  unitCost: string;
  /** unitCost × validCount, 4 decimales. */
  estimatedCost: string;
  /** `false` si `estimatedCost > available`. `false` también cuando `unknown` (fail-safe). */
  sufficient: boolean;
  /** Presente y `true` cuando el balance no se pudo leer o la moneda no coincide. */
  unknown?: true;
}

export function estimateMessagingCost(args: {
  /** `template.category` de `listTemplates` — puede venir undefined (template pending). */
  category: string | undefined;
  validCount: number;
  rates: MessagingRatesConfig;
  /** `null` ⇒ el balance no se pudo leer ⇒ `unknown:true`, `sufficient:false`. */
  balance: CreditBalance | null;
}): MessagingCreditDto;
```

Reglas, todas puras y totales (nunca tira):

1. `normalizeCategory(category)`: trim + upper; si no es una de las 3 → `MARKETING` +
   `categoryAssumed: true`. **Fail-safe: MARKETING es la más cara** (0.0618) — sobre-estima y
   bloquea de más; nunca sub-estima y gasta de más.
2. `unitCostMicro = addMoney(parseMoney(rateFor(category)), parseMoney(rates.providerFee))`.
   Una tarifa ilegible en la fila (SQL a mano) → `tryParseMoney` da `null` → se trata como
   `unknown: true` (nunca como 0: un 0 fabricado abre el guard en silencio — memoria
   *basura-al-valor-SEGURO-no-al-default*).
3. `estimatedCostMicro = multiplyMoneyByCount(unitCostMicro, validCount)`.
4. `currency`: la de `rates`. Si `balance !== null` y `balance.currency !== rates.currency` ⇒
   `unknown: true`, `available: null`, `sufficient: false`. **No se convierte** (out of scope).
5. `sufficient = balance !== null && !unknown && compareMoney(estimatedCostMicro, parseMoney(balance.amount)) <= 0`.

### D4.b — `ValidateExternalBulk` (MOD) — advisory, NUNCA tira

Constructor: 2 dependencias nuevas al final, **antes** del `now` (que tiene default), quedando 11:

```ts
    private readonly rbacUserRepo: RbacUserRepository,
    private readonly creditPort: CreditBalancePort,               // NEW
    private readonly ratesRepo: MessagingRatesConfigRepository,   // NEW
    private readonly now: () => Date = () => new Date(),
```

**Punto de inserción exacto: entre la línea 164 (`throw new CapExceededError({limit:'perDay'…})` /
cierre del bloque de caps) y la línea 166 (comentario `// 10 — VAL-8 — persist preview…`)**:

```ts
    // 9.5 — CRÉDITO (ADVISORY). Después de los caps: si el lote ni siquiera
    // entra por cantidad, el número de plata es ruido. NUNCA voltea el request.
    const credit = await this.resolveCredit(template.category, valid.length);
    const warnings = creditWarnings(credit);   // ['INSUFFICIENT_CREDIT'] | ['CREDIT_UNAVAILABLE'] | []
```

```ts
  /** ADVISORY — cualquier falla (balance, rates, parseo) degrada a `unknown`, jamás tira. */
  private async resolveCredit(category: string | undefined, validCount: number): Promise<MessagingCreditDto> {
    let rates: MessagingRatesConfig;
    try { rates = await this.ratesRepo.get(); }
    catch { rates = { ...MESSAGING_RATES_CONFIG_DEFAULTS, updatedAt: this.now().toISOString() }; }
    let balance: CreditBalance | null = null;
    try { balance = await this.creditPort.getBalance(); } catch { balance = null; }
    return estimateMessagingCost({ category, validCount, rates, balance });
  }
```

`credit` viaja a DOS lugares:

- **`previewRepo.create({ …, credit })`** (línea ~182-205) — evidencia auditable de "qué se le
  mostró al que autorizó" (D1.b). Se suma a `ExternalBulkPreviewCreateData` y a la entidad
  `ExternalBulkPreview` como `credit: MessagingCreditDto | null`.
- **el `return` (línea 218-226)**: `{ …, caps, credit, ...(warnings.length ? { warnings } : {}) }`.
  `warnings` es **opcional y ausente cuando está vacío** — un array vacío en el wire invita a un
  `if (r.warnings)` que siempre da true.

`ValidateExternalBulkOutput` (`external-bulk-messaging.dto.ts:84-94`) suma
`credit: MessagingCreditDto;` y `warnings?: ExternalBulkWarning[];` con
`export type ExternalBulkWarning = 'INSUFFICIENT_CREDIT' | 'CREDIT_UNAVAILABLE';`.

### D4.c — `SendExternalBulk` (MOD) — gate fail-closed

Constructor: 2 dependencias nuevas antes del `now`, quedando 12 (mismas 2 instancias que `validate`).

**Punto de inserción exacto: entre la línea 155 (cierre del `if (preview.recipients.length >
remainingToday) throw new CapExceededError…`) y la línea 157 (comentario `// 5 — SEND-5/SEND-10,
crea la Campaign…`)** — es decir, después de TODA la re-validación de SEND-4 y **antes** de
`CreateCampaign` y de `markConsumed`:

```ts
    // 4.5 — SEND-4bis, GATE de crédito, fail-closed. Contra los recipients que
    // REALMENTE se van a crear (`preview.recipients.length`) — nunca contra el
    // snapshot del preview, mismo criterio que template/label/caps.
    // fix wave F1 (F3): desde acá hasta `start()` corre DENTRO de `creditMutex`.
    await this.assertSufficientCredit(template.category, preview.recipients.length);
```

```ts
  private async assertSufficientCredit(category: string | undefined, count: number): Promise<void> {
    // fix wave F1 (F7) — perilla propia; apagada, el gate NO corre (D10.h).
    if (!(await this.resolveCreditGuardEnabled())) return;
    let credit;
    try {
      // fix wave F1 (F4) — `ratesRepo.get()` vivía FUERA de este try y subía
      // como 500 crudo; el contrato de CG-SEND-3 es 503 CREDIT_UNAVAILABLE.
      const rates = await this.ratesRepo.get();
      // fix wave F1 (F1) — `fresh:true`: la cache de 60s que llenó el `validate`
      // servía el saldo PRE-gasto. El camino advisory SIGUE usando la cache.
      const balance = await this.creditPort.getBalance({ fresh: true });
      credit = estimateMessagingCost({ category, validCount: count, rates, balance });
    } catch { throw new CreditUnavailableError(); }    // fail-closed, TODO adentro
    if (credit.unknown) throw new CreditUnavailableError();   // incluye moneda ≠ y tarifa ilegible
    if (!credit.sufficient) {
      throw new InsufficientCreditError({
        available: credit.available as string,
        estimatedCost: credit.estimatedCost,
        currency: credit.currency,
      });
    }
  }
```

**El path de replay (`private async replay(...)`, líneas 289-315) NO SE TOCA** — ni una línea. La
plata ya está comprometida cuando la campaña existe; volver a cobrarla sería contar dos veces, el
MISMO criterio explícito que ya rige los caps en el replay (comentario F3.a, `:276-278`).

### D4.d — `GetMessagingCredit` (NEW) — alimenta `GET /credit` y la card FE

```ts
// src/application/use-cases/messaging/GetMessagingCredit.ts
export interface GetMessagingCreditOutput {
  available: string; currency: string; fetchedAt: string; cached: boolean;
  rates: { currency: string; utilityRate: string; marketingRate: string;
           authenticationRate: string; providerFee: string; updatedAt: string };
}
export class GetMessagingCredit {
  constructor(private readonly creditPort: CreditBalancePort,
              private readonly ratesRepo: MessagingRatesConfigRepository) {}
  /** Throws `CreditUnavailableError` (503) — acá SÍ es un error: es lo único que devuelve el endpoint. */
  async execute(): Promise<GetMessagingCreditOutput>;
}
```

### D4.e — `GetMessagingRatesConfig` / `SetMessagingRatesConfig` (NEW)

Clon 1:1 de `GetExternalBulkConfig`/`SetExternalBulkConfig`. El `Set` recibe **`unknown`** (última
barrera de tipo antes del repo, mismo criterio y misma prosa que `SetExternalBulkConfig.ts:9-14`) y
tira `ExternalBulkValidationError` (código `VALIDATION_ERROR` → 400) cuando:

```ts
const DECIMAL_4_RE = /^\d+(\.\d{1,4})?$/;   // >= 0, <= 4 decimales, sin signo, sin notación exp
const CURRENCY_RE  = /^[A-Z]{3}$/;
```

- alguna de las 4 tarifas no es `string` que matchee `DECIMAL_4_RE` (`'-0.01'`, `'0.06185'`,
  `'1e-2'`, `0.012` como number ⇒ 400 — el wire manda strings, y aceptar un number reintroduce el
  float que D2 saca de raíz);
- `currency` no matchea `CURRENCY_RE`.

Normaliza a 4 decimales con `formatMoney(parseMoney(x))` antes de persistir, así lo que se lee es
siempre lo mismo que se escribió.

---

## D5 — HTTP

### D5.a — `GET /credit` en el router externo (MOD `external-messaging.routes.ts`)

Ruta HERMANA de `GET /campaigns/:id`, **registrada antes del catch-all** (`:251`), sin
`writeRateLimiter` (es una lectura). Kill-switch explícito, molde de las rutas de templates
(`isFeatureEnabled()`, `:117-123`); la key dedicada la aplica el mount.

```ts
  // ─── GET /credit — saldo + tarifas vigentes, sin disparar nada ─────────────
  router.get('/credit', async (_req, res, next) => {
    try {
      if (!(await isFeatureEnabled())) throw new FeatureExternalBulkDisabledError();
      res.status(200).json(await deps.getMessagingCredit.execute());
    } catch (err) { next(err); }
  });
```

`ExternalMessagingRouterDeps` suma `getMessagingCredit: GetMessagingCredit;`.
Wire: **200** `{available, currency, fetchedAt, cached, rates:{…}}` · **503** `CREDIT_UNAVAILABLE`
(del `statusMap`) · **403** `FEATURE_DISABLED` · **401** sin key.

### D5.d — fix wave F1: contrato de wire del bloque `credit` (F8) y asimetría de kill-switch (R2 #8)

**F8 — `unitCost`/`estimatedCost` son NULLABLE.** Antes decían `"0.0000"` cuando la tarifa no se
podía resolver. Un cero es un NÚMERO: la card FE y la IA que consume la API externa lo leen como
"gratis". La verdad era "no sé". Tipo nuevo en el wire de `POST /validate` y en el snapshot
`ExternalBulkPreview.credit`:

```ts
  unitCost: string | null;       // null ⇒ la TARIFA no se pudo resolver
  estimatedCost: string | null;  // null en los MISMOS casos que unitCost
```

Regla exacta — `null` **solo** cuando falló la lectura del COSTO (fila de tarifas ilegible, repo de
tarifas caído, overflow de punto fijo, guard apagado). Si lo que falló fue el SALDO (balance
inalcanzable, moneda distinta), el bloque igual viaja `unknown:true` con `available:null` pero
`unitCost`/`estimatedCost` **siguen siendo números**: el costo sí se conoce y es información útil.
Cambio ADITIVO para el caller (el campo ya existía; ahora puede venir `null`) — la skill
`whatsapp-bulk-ipnext` tiene que contemplarlo antes de formatear.

**F7 — warning nueva.** `ExternalBulkWarning` suma `CREDIT_GUARD_DISABLED` (ver D10.h). Semántica:
"no se midió" ≠ "no se pudo medir" (`CREDIT_UNAVAILABLE`).

**R2 #8 — asimetría DELIBERADA del kill-switch.** `GET /credit` (router EXTERNO) está detrás de
`messaging-external-bulk-enabled`: con la API externa apagada devuelve **403 FEATURE_DISABLED** sin
tocar Twilio. `GET /api/messaging/config/rates/balance` (router ADMIN, sesión + `messaging:read`)
**NO** lo está, y es correcto: el kill-switch apaga el ENVÍO M2M, no la capacidad del operador de
mirar cuánto saldo hay — justamente lo primero que uno quiere ver cuando apagó los envíos.

### D5.b — `details` del 422 en `POST /send` (MOD)

El `errorHandler` no serializa campos extra (D3.d). En el `catch` del `/send`
(`external-messaging.routes.ts:150-165`), junto al bloque ya existente de `CampaignRunnerBusyError`:

```ts
      if (err instanceof InsufficientCreditError) {
        res.status(422).json({
          error: err.message, code: err.code,
          details: { available: err.available, estimatedCost: err.estimatedCost, currency: err.currency },
        });
        return;
      }
```

`CreditUnavailableError` NO necesita nada acá: `{error, code}` + 503 del `statusMap` alcanzan.

### D5.c — `messaging-rates-config.routes.ts` (NEW) — clon del router de config

`src/infrastructure/http/routes/messaging-rates-config.routes.ts` (kebab-case; el vecino
`externalBulkMessagingConfig.routes.ts` es camel por herencia — la convención nueva manda).
Sesión (NO api-key), respuesta **FLAT sin envelope** (molde exacto).

```ts
export interface MessagingRatesConfigRoutePerms { read: RequestHandler; manage: RequestHandler; }
export function createMessagingRatesConfigRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  perms: MessagingRatesConfigRoutePerms,
  getMessagingRatesConfig: GetMessagingRatesConfig,
  setMessagingRatesConfig: SetMessagingRatesConfig,
  getMessagingCredit: GetMessagingCredit,
): Router
```

| Método | Path | Gate | Respuesta |
|---|---|---|---|
| GET | `/` | `messaging:read` | `{currency, utilityRate, marketingRate, authenticationRate, providerFee, updatedAt}` |
| PUT | `/` | `messaging:manage` | idem · 400 `VALIDATION_ERROR` |
| GET | `/balance` | `messaging:read` | `{available, currency, fetchedAt, cached}` · 503 `CREDIT_UNAVAILABLE` |

**Decisión (la que pedía el orquestador)**: el saldo para el FE se expone como **`GET
/api/messaging/config/rates/balance`**, sub-ruta de este mismo router, NO como un
`/api/messaging/credit` aparte. Razones: (1) la card FE es UNA — un prefijo, un mount, un
`ExternalBulkMessagingCard`-like que hace 2 fetch al mismo padre; (2) evita un mount nuevo en el
God Object `app.ts` (deuda HIGH declarada); (3) reusa `GetMessagingCredit` tal cual, sin use case
nuevo. Se devuelve **sin** el bloque `rates` (la card ya lo tiene del `GET /`) — el que necesita
los dos juntos en una sola llamada es el caller M2M, y para eso está `GET /credit` (D5.a).

---

## D6 — Wiring en `app.ts` (God Object — bloque self-contained, mínimo)

**Instancia única compartida validate/send.** Dentro del bloque bulk existente, entre la línea 3611
(`const externalBulkConfigRepo = …`) y el `app.use(...)` de 3612:

```ts
    // twilio-credit-guard — 4ª instancia Twilio, self-contained (molde "Change 3",
    // :3674). NO se reusa `templatePort`: implementa otros 2 ports y este gateway
    // tiene su propio timeout (10s) y su propia cache. MISMAS creds, cero env nueva.
    const creditBalancePort = new TwilioCreditBalanceGateway({
      accountSid: config.twilio.accountSid,
      authToken: config.twilio.authToken,
    });
    const messagingRatesRepo = new PrismaMessagingRatesConfigRepository();
```

Se pasan a `new ValidateExternalBulk(…, rbacUserRepo, creditBalancePort, messagingRatesRepo)`,
a `new SendExternalBulk(…, bulkCreateCampaign, campaignRunner, creditBalancePort, messagingRatesRepo)`
— **la MISMA instancia del gateway en los dos**, para que la cache de 60 s sirva a ambos (un
`validate` seguido de un `send` no le pega dos veces a Twilio) — y a
`getMessagingCredit: new GetMessagingCredit(creditBalancePort, messagingRatesRepo)` en las deps del
router. El marcador `[external-bulk-mount-end]` (`:3658`) **no se toca**.

**Mount del router de config**, bloque nuevo pegado al de external-bulk (después de la línea 3788,
molde línea por línea de `:3776-3788`). **SUPERADO por fix wave F1 (R2#4):** el router de config
recibe la MISMA instancia `creditBalancePort`/`messagingRatesRepo` del bloque bulk (una sola cache);
`creditPortForRoute`/`messagingRatesRepoForRoute` ya no existen en `app.ts`. El bloque de abajo queda
como referencia histórica del molde:

```ts
  {
    const messagingRatesRepoForRoute = new PrismaMessagingRatesConfigRepository();
    const creditPortForRoute = new TwilioCreditBalanceGateway({
      accountSid: config.twilio.accountSid, authToken: config.twilio.authToken,
    });
    app.use('/api/messaging/config/rates', createMessagingRatesConfigRouter(
      authAdapter, sessionRepo,
      { read: requirePerm('messaging', 'read'), manage: requirePerm('messaging', 'manage') },
      new GetMessagingRatesConfig(messagingRatesRepoForRoute),
      new SetMessagingRatesConfig(messagingRatesRepoForRoute),
      new GetMessagingCredit(creditPortForRoute, messagingRatesRepoForRoute),
    ));
  }
```

Instancias PROPIAS (mismo criterio anti-interleave que documentan los 3 bloques vecinos). Cache
separada de la del bloque bulk: son 2 slots de 60 s sobre el mismo endpoint — a lo sumo 2
requests/minuto contra Twilio, irrelevante, y no acopla la card admin al camino de envío.

**Sin env vars nuevas. Sin dependencias npm nuevas.**

---

## D7 — Testing (TDD estricto: red → green → refactor)

| Suite (archivo) | Qué pinea |
|---|---|
| `src/__tests__/domain/fixedPointMoney.test.ts` | `parseMoney('17.894')===178940`; `'0.0618'`×500 = `'30.9000'` EXACTO; half-up (`'0.00005'`→1, `'0.00004'`→0); negativos; rechazo de `''`/`'1e3'`/`'NaN'`/`'1,5'`/`null`; `formatMoney` siempre 4 decimales; **round-trip** `format(parse(x))===x` para 4-decimales; `multiplyMoneyByCount` con count no entero tira |
| `src/__tests__/infrastructure/TwilioCreditBalanceGateway.test.ts` | http fake: 200 con el body REAL de prod (`{"balance":"17.894","currency":"USD"}`) → `amount:'17.8940'`, `cached:false`; 401/403/404/429/500/timeout/red/JSON basura/`balance:'abc'` → `CreditUnavailableError`; **cache**: 2 llamadas dentro de 60 s ⇒ 1 sola request + `cached:true`; reloj +60_001 ms ⇒ 2ª request; **el error NO se cachea** (falla, luego éxito ⇒ 2 requests); URL y Basic auth asserteados |
| `src/__tests__/application/messaging/EstimateMessagingCost.test.ts` | las 3 categorías; `undefined`/`'promocional'` ⇒ MARKETING + `categoryAssumed`; `balance:null` ⇒ `unknown`+`sufficient:false`; **moneda ≠ ⇒ `unknown`, NUNCA una comparación a ciegas**; tarifa ilegible ⇒ `unknown` (no 0); borde `estimatedCost === available` ⇒ `sufficient:true` |
| `…/ValidateExternalBulk.test.ts` (MOD) | `credit` en la salida + en el snapshot del preview; insuficiente ⇒ **200** + `warnings:['INSUFFICIENT_CREDIT']`; gateway caído ⇒ **200** + `unknown` + `warnings:['CREDIT_UNAVAILABLE']`; **`payloadHash` idéntico al de antes del change** (valor literal hardcodeado) |
| `…/SendExternalBulk.test.ts` (MOD) | insuficiente ⇒ `InsufficientCreditError` y **cero campañas creadas + preview NO consumido**; balance caído / moneda ≠ ⇒ `CreditUnavailableError`, cero campañas; **replay no llama `getBalance()`** (`calls===0`); **orden**: cap excedido Y sin crédito ⇒ `CAP_EXCEEDED`; template no aprobado Y sin crédito ⇒ `TEMPLATE_NOT_APPROVED` |
| `…/external-messaging.routes.test.ts` (MOD) | `GET /credit` 200 / 503 / 403 flag off / 401 sin key; `/send` 422 con `details:{available,estimatedCost,currency}`; `/send` 503; `/validate` 200 con `warnings` |
| `src/__tests__/infrastructure/messaging-rates-config.routes.test.ts` (NEW) | GET/PUT 200; 401 sin sesión, 403 sin perm; PUT con `-0.01`/`'0.06185'`/`currency:'usd'`/number ⇒ 400 `VALIDATION_ERROR`; `GET /balance` 200/503 |
| `src/__tests__/infrastructure/twilio-credit-guard-composition.test.ts` (NEW) | el mount de `/api/messaging/config/rates` existe; `ValidateExternalBulk`/`SendExternalBulk` reciben `TwilioCreditBalanceGateway` + `PrismaMessagingRatesConfigRepository` (scan de fuente, molde `external-bulk-messaging-composition.test.ts`) |
| `…/InMemoryMessagingRatesConfigRepository.test.ts` (NEW) | defaults sin fila; `set` persiste y actualiza `updatedAt` |

Todos los use cases se testean con **adapters in-memory**, nunca con Prisma mockeado ni axios real.

---

## D8 — FE (repo `ipnext-frontend` — se DESCRIBE, no se implementa acá)

**Card nueva `MessagingRatesCard.tsx`** en `Config → WhatsApp` (`WhatsappSettingsPage.tsx`), hermana
de `ExternalBulkMessagingCard.tsx` (mismo molde de estados y de submit), **no** una extensión de
ella: son dos configs distintas con dos permisos que ya existen.

Contrato campo por campo:

| Momento | Llamada | Respuesta usada |
|---|---|---|
| mount | `GET /api/messaging/config/rates` | `currency`, `utilityRate`, `marketingRate`, `authenticationRate`, `providerFee`, `updatedAt` → 5 inputs controlados + "actualizado el …" |
| mount (paralelo) | `GET /api/messaging/config/rates/balance` | `available`, `currency`, `fetchedAt`, `cached` → "Saldo Twilio: **17.8940 USD**" + "hace N s" y un badge discreto cuando `cached` |
| guardar | `PUT /api/messaging/config/rates` body `{currency, utilityRate, marketingRate, authenticationRate, providerFee}` (**strings**, tal cual se tipearon) | 200 mismo shape ⇒ se re-siembra el form; 400 `VALIDATION_ERROR` ⇒ error inline |

- **La regex `STRICT_INTEGER_RE` de `ExternalBulkMessagingCard` NO sirve** — acá va
  `/^\d+(\.\d{1,4})?$/` (misma que valida el BE, D4.e) y `currency` `/^[A-Z]{3}$/` con
  `toUpperCase()` al tipear. Se manda **string**, nunca `Number(input)`: un `parseFloat` en el FE
  reintroduce el float que todo D2 sacó de raíz.
- **4 estados** (molde de la card vecina): `loading` (skeleton), `error` (fetch caído, con reintentar),
  `ok`, `saving` (botón deshabilitado). El bloque de saldo tiene su propio estado: un 503 muestra
  "Saldo no disponible" **sin** romper la edición de tarifas.
- **Confirm al guardar** (`window.confirm` o el modal del design system): "Estas tarifas gobiernan
  el bloqueo de envíos masivos. ¿Confirmás?" — poner las 4 en 0 desactiva el guard (D9), y eso no
  puede pasar por un click distraído.
- Preview de bulk (si/cuando el FE consuma `validate`): renderizar `credit.estimatedCost` +
  `credit.available` y un banner ámbar por cada `warnings[]`; `categoryAssumed:true` ⇒ "categoría
  asumida MARKETING (la más cara)".

---

## D9 — Rollout y rollback

1. **Deploy** de la migración + el código. La fila singleton nace **perezosa** en el primer `get()`
   (fix F14 clonado) con los defaults `0.0120/0.0618/0.0220/0.0050 USD`.
2. **El guard queda activo de inmediato.** Con el saldo real de hoy (17.894 USD) y MARKETING
   (`0.0618 + 0.0050 = 0.0668`), el techo por lote es ~**267 mensajes**; con UTILITY (`0.0170`),
   ~1052. Es decir: **un lote de 500 MARKETING se rechaza el día 1 con 422**. Es el comportamiento
   deseado (hoy se enviaría a medias y se cortaría sin explicación), pero hay que avisarlo antes
   de deployar, no descubrirlo en la primera campaña.
3. **Rollback sin deploy**: poner las 4 tarifas en `0` desde la card ⇒ `estimatedCost = '0.0000'`
   ⇒ `sufficient` siempre true ⇒ guard inerte. El kill-switch existente sigue apagando todo el bulk.
4. **Rollback de código**: revertir el mount de `messaging-rates-config.routes.ts` y el `GET /credit`;
   las rutas dejan de existir, nada más las referencia. Tabla y columna quedan inertes (aditivas,
   nullable) — sin migración inversa. Los previews vivos NO se invalidan: el `payloadHash` no cambió.

---

## D10 — Riesgos y deuda DECLARADA

| # | Riesgo | Mitigación / decisión |
|---|---|---|
| D10.a | ~~**Cache de 60 s**: el balance del `send` puede estar hasta 60 s stale~~ **REVISADO — fix wave F1 (F1): YA NO SE ACEPTA** | El razonamiento original ("margen de segundos") estaba mal calibrado: el flujo NORMAL de 2 pasos es `validate` (que LLENA la cache) → `send` segundos después, con lo cual el gate comparaba SIEMPRE contra el saldo PRE-gasto — no era un borde raro, era el camino feliz. Ahora el gate del `send` llama `getBalance({fresh:true})` (saltea y refresca el slot) y, tras aceptar un envío, `creditPort.invalidate()`. El camino ADVISORY (`validate`, `GET /credit`) SIGUE usando la cache: ahí un número de hace 30 s informa, no decide plata |
| D10.b | **Sin reserva atómica**: dos `send` concurrentes pasan el guard con el mismo saldo | **PARCIALMENTE RESUELTO — fix wave F1 (F3)**: el tramo gate → `CreateCampaign` → `markConsumed` → `start` se serializa con un `AsyncMutex` en proceso (`application/use-cases/messaging/asyncMutex.ts`, cero dependencia nueva). Alcance DECLARADO: protege UNA instancia del proceso, no un cluster — suficiente porque `CampaignRunner` ya es uno por proceso (lock global, D6). Si eso cambiara, el candado sube a un advisory lock de Postgres (el mismo molde que ya usa el runner). `remainingToday` sigue con el agujero original: es cupo, no plata |
| D10.h | **fix wave F1 (F7)** — el guard no tenía perilla propia | Feature flag `messaging-credit-guard-enabled` (sembrado en **TRUE** por la migración de este change). OFF ⇒ `validate` devuelve `credit.unknown:true` + warning `CREDIT_GUARD_DISABLED` y `send` SALTEA el gate (fail-OPEN por decisión EXPLÍCITA del operador). Fila ausente o repo de flags caído ⇒ **ON** (fail-closed: una protección no se apaga sola). Se opera con el `PATCH /api/admin/feature-flags/:key` genérico que ya existe — cero FE nuevo |
| D10.i | **fix wave F1 (R2 #4)** — dos instancias de `TwilioCreditBalanceGateway` en `app.ts` | Unificadas en UNA sola, hoisteada arriba del bloque bulk y compartida con el router de config admin. Dos gateways = dos caches de 60 s sobre el MISMO saldo (dos verdades simultáneas) + una invalidación post-send que solo alcanza a una. Pineado por `twilio-credit-guard-composition.test.ts` ("existe EXACTAMENTE UNA instanciación") |
| D10.c | **Category drift**: `category` de `/ContentAndApprovals` ≠ `approvalCategory` de `/ApprovalRequests` | Se usa `category` (cero latencia nueva, ya disponible). Si aparece drift, el fix es cambiar la fuente en UN lugar (`estimateMessagingCost` recibe el string, no lo busca) |
| D10.d | **Alcance del token Twilio**: si la cuenta es sub-cuenta o el token no tiene permiso sobre `Balance.json` | Verificado en vivo hoy con las creds de prod: 200. Si rotan a un token sin scope ⇒ 401 ⇒ `CREDIT_UNAVAILABLE` ⇒ **todos los `send` bloqueados**. Consecuencia deliberada del fail-closed; `validate` sigue funcionando (advisory) para no dejar ciego al operador |
| D10.e | Tarifas desactualizadas vs. Meta | Editables sin deploy desde la card. El número es una ESTIMACIÓN declarada, no una factura |
| D10.f | Cuenta no-USD | No se convierte: `currency` ≠ ⇒ 503 explícito. Asunción USD EXPLÍCITA |
| D10.g | `app.ts` como punto de colisión (God Object, deuda HIGH) | Bloque self-contained + `twilio-credit-guard-composition.test.ts` que pinea el mount y las dependencias |

## Open Questions

Ninguna. Las 4 aperturas de la exploración quedaron cerradas en el proposal, y las 2 que dejó el
proposal (dónde vive el saldo para el FE, cómo se hace la aritmética) se cierran acá en D5.c y D2.
