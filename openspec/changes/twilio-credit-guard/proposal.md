# Proposal: twilio-credit-guard — saldo Twilio + costo estimado del lote antes de autorizar el envío

## Intent

Hoy `POST /api/external/v1/messaging/bulk/validate` reporta CONTEOS, nunca PLATA (scope-out
explícito del change anterior: "no existe tarifa modelada en el repo"). Una IA puede autorizar un
lote de 500 mensajes sin saber si la cuenta Twilio tiene saldo — y el resultado de quedarse sin
crédito a mitad de campaña es peor que un rechazo: mensajes a medias, clientes contactados a
medias, y un `CampaignRunner` que falla mensaje por mensaje sin explicación de dinero. Este change
cierra ese agujero: **el preview muestra cuánto va a costar y cuánto hay; el `send` no gasta plata
que no tiene.**

## Scope

### In Scope (BE)
- Port SEGREGADO `CreditBalancePort` (`getBalance(): Promise<{amount, currency, fetchedAt}>`) +
  adapter `TwilioCreditBalanceGateway` contra `GET https://api.twilio.com/2010-04-01/Accounts/{sid}/Balance.json`
  (Basic auth con las MISMAS creds `config.twilio.*`, cero env var nueva) + cache single-slot TTL 60 s
  con reloj inyectable (molde `SmartOltHttpGateway`) + `InMemoryCreditBalancePort` para tests.
- Singleton `MessagingRatesConfig` (Prisma, molde exacto `ExternalBulkMessagingConfig`) con
  `currency`/`utilityRate`/`marketingRate`/`authenticationRate`/`providerFee`/`updatedAt`, todos `Decimal`.
- Router admin `GET|PUT /api/messaging/config/rates` (sesión, `messaging:read` / `messaging:manage`,
  respuesta FLAT sin envelope) — molde `externalBulkMessagingConfig.routes.ts`.
- `validate`: bloque `credit` en la respuesta **y** persistido en el snapshot `ExternalBulkPreview`
  (columna nueva, FUERA del `payloadHash`). Crédito insuficiente **NO** falla `validate`.
- `send`: re-chequeo del crédito contra los destinatarios que realmente se van a crear;
  insuficiente → **422 `INSUFFICIENT_CREDIT`**; balance inalcanzable o moneda distinta a la de la
  config → **503 `CREDIT_UNAVAILABLE`** (fail-closed).
- `GET /api/external/v1/messaging/bulk/credit` (misma key dedicada, mismo kill-switch) para ver
  saldo + tarifas vigentes sin disparar nada.
- Aritmética de plata en punto fijo de 4 decimales (enteros de 1/10000) en la capa application.

### In Scope (FE, `ipnext-frontend` — se DESCRIBE, no se implementa acá)
- Card nueva en Config → WhatsApp (molde `ExternalBulkMessagingCard.tsx`): saldo vivo + las 5
  tarifas editables. La regex `STRICT_INTEGER_RE` de esa card NO sirve: son decimales.

### Out of Scope
- **Reserva atómica de crédito.** No existe en el repo (ni el cupo diario reserva) — el gate es el
  re-chequeo en `send`, igual que `remainingToday`. Riesgo aceptado y documentado.
- **Conversión de moneda.** No hay ninguna en el repo. Si la moneda del balance ≠ la de la config,
  se falla 503, no se convierte.
- Costo REAL post-envío (Twilio lo expone por mensaje enviado); acá solo hay ESTIMACIÓN previa.
- Alertas/umbral de saldo bajo, historial de consumo, tope de gasto diario en $.
- Segundo GET a `.../ApprovalRequests` para leer `approvalCategory` (se usa `template.category`,
  ya disponible en `listTemplates`, cero latencia nueva).
- **Fase posterior**: sección "Crédito" en la skill `whatsapp-bulk-ipnext`, después de verificación en vivo.

## Capabilities

### New Capabilities
- `messaging-credit-guard`: saldo del proveedor (puerto + cache TTL), tarifas configurables por
  categoría de template, estimación de costo en punto fijo, y las reglas de advisory (`validate`) vs
  gate fail-closed (`send`).

### Modified Capabilities
- `external-bulk-messaging`: extensión ADITIVA — `validate` suma `credit` + `warnings` a su salida y
  al snapshot; `send` suma un re-chequeo más a SEND-4 (mismo molde que caps/template/label); ruta
  nueva hermana `GET /credit`. Ningún requirement existente cambia de semántica.

## Approach

1. **La categoría ya está.** `ValidateExternalBulk` resuelve el template vía `listTemplates()`, que
   ya puebla `category` desde `approval_requests.category`. Cero llamada extra.
2. **Categoría ausente/desconocida → se tarifa como `MARKETING`** (la más cara, fail-safe: nunca
   subestima) y se marca `credit.categoryAssumed: true` para que el humano lo vea.
3. **Costo = válidos × (tarifa Meta de la categoría + `providerFee`)**, todo en enteros de 1/10000;
   la COMPARACIÓN se hace sobre esos enteros, el redondeo half-up a 4 decimales es solo para mostrar.
4. **`validate` es advisory** (mismo criterio que el resto del preview): 200 con
   `credit.sufficient=false` + `warnings: ['INSUFFICIENT_CREDIT']`. El operador/la IA VE el preview y
   decide. Balance inalcanzable → `credit.unknown=true` + `warnings: ['CREDIT_UNAVAILABLE']`, tampoco
   falla.
5. **`send` es el gate**, fail-closed: re-lee el balance (cache permitido) y recalcula contra los
   destinatarios de AHORA. El **replay** (misma `Idempotency-Key`, campaña ya creada) NO re-chequea
   crédito — la plata ya está comprometida, igual que los caps.
6. **El crédito NO entra al `payloadHash`.** Es dato del proveedor, no input del caller: el balance
   de las 15:00 no es el de las 15:05 y meterlo rompería la re-hasheabilidad determinística de SEND-3.
   Se persiste en el snapshot solo como evidencia auditable de "qué se le mostró al que autorizó".

## Data model sketch

| Modelo | Campos |
|--------|--------|
| `MessagingRatesConfig` (NEW, singleton) | `id @default("singleton")`, `currency String @default("USD")`, `utilityRate Decimal @db.Decimal(10,4) @default(0.0120)`, `marketingRate` `@default(0.0618)`, `authenticationRate` `@default(0.0220)`, `providerFee` `@default(0.0050)`, `updatedAt` |
| `ExternalBulkPreview` (MOD) | `+ credit Json?` — snapshot advisory `{available, currency, category, categoryAssumed, unitCost, estimatedCost, sufficient, unknown, fetchedAt}`. Nullable/aditiva, FUERA del `payloadHash` (previews vivos siguen re-hasheando idéntico) |

Una sola migración: tabla nueva + columna nullable. Sin FK, sin backfill.

## Wire contract sketch

`POST /validate` → **200**, se AGREGA a la respuesta existente:
```
credit: { available, currency, category, categoryAssumed?, unitCost, estimatedCost, sufficient, unknown? }
warnings?: ['INSUFFICIENT_CREDIT' | 'CREDIT_UNAVAILABLE']
```

`POST /send` → **202** igual que hoy | **422** `{code:'INSUFFICIENT_CREDIT', details:{available, estimatedCost, currency}}` | **503** `{code:'CREDIT_UNAVAILABLE'}`

`GET /credit` (key dedicada + kill-switch) → **200**
`{ available, currency, fetchedAt, cached: boolean, rates:{currency, utilityRate, marketingRate, authenticationRate, providerFee} }` | **503** `CREDIT_UNAVAILABLE`

`GET /api/messaging/config/rates` (sesión, `messaging:read`) → **200** body FLAT con las 5 tarifas + `updatedAt`
`PUT` (`messaging:manage`) → **200** el mismo shape | **400** `VALIDATION_ERROR`
(validación: decimales ≥ 0 con ≤ 4 decimales; `currency` exactamente 3 letras)

| Código | HTTP | Cuándo |
|--------|------|--------|
| `INSUFFICIENT_CREDIT` | 422 | solo en `send`: `estimatedCost > available`. En `validate` es un `warning`, no un error |
| `CREDIT_UNAVAILABLE` | 503 | `Balance.json` inalcanzable/5xx/timeout, o moneda del balance ≠ moneda de la config (fail-closed, nunca se compara a ciegas) |
| `VALIDATION_ERROR` | 400 | `PUT /config/rates` con tarifa negativa, >4 decimales o `currency` inválida |

Errores nuevos en `domain/errors/external-bulk-messaging.ts` (molde `CapExceededError` /
`ReporterUnavailableError`) + 2 entradas en el `statusMap` de `errorHandler.ts`.

## Affected Areas

| Área | Impacto | Descripción |
|------|---------|-------------|
| `prisma/schema.prisma` + migration | New/Mod | `MessagingRatesConfig` + `ExternalBulkPreview.credit Json?` |
| `src/domain/ports/CreditBalancePort.ts`, `MessagingRatesConfigRepository.ts` | New | Ports segregados (ISP): el fake de crédito no sabe nada de templates |
| `src/domain/errors/external-bulk-messaging.ts` | Mod | `InsufficientCreditError` (422), `CreditUnavailableError` (503) |
| `src/application/use-cases/messaging/ValidateExternalBulk.ts` | Mod | Bloque de crédito después de los caps; +2 dependencias inyectadas (van 11) |
| `src/application/use-cases/messaging/SendExternalBulk.ts` | Mod | Re-chequeo en el bloque SEND-4; el path de replay lo SALTEA |
| `src/application/use-cases/messaging/GetMessagingCredit.ts` | New | Alimenta `GET /credit` |
| `src/application/dto/external-bulk-messaging.dto.ts` | Mod | `credit` + `warnings` en `ValidateExternalBulkOutput` |
| `src/infrastructure/adapters/twilio/TwilioCreditBalanceGateway.ts` | New | Basic auth + cache single-slot 60 s |
| `src/infrastructure/adapters/{prisma,in-memory}/*MessagingRatesConfigRepository.ts` | New | Molde 1:1 del par de `ExternalBulkMessagingConfig` (ojo fix wave F14: no fabricar `updatedAt` sin fila) |
| `src/infrastructure/adapters/in-memory/InMemoryCreditBalancePort.ts` | New | Fake chico; NO se toca `InMemoryTemplateMessagingGateway` |
| `src/infrastructure/http/routes/external-messaging.routes.ts` | Mod | `GET /credit` hermana, solo lectura |
| `src/infrastructure/http/routes/messagingRatesConfig.routes.ts` | New | Router de config admin |
| ⚠️ `src/infrastructure/http/app.ts` | Mod | **God Object (deuda HIGH)**: 4ª instancia Twilio (self-contained, molde "Change 3") + mount del router de config. Punto de colisión entre sesiones paralelas |
| `ipnext-frontend` Config → WhatsApp | Mod | Cambio coordinado, no bloqueante del BE |

Sin dependencias nuevas de Splynx. Sin env vars nuevas.

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| **Cache de 60 s: el balance del `send` es stale y se autoriza un lote que no entra** | Media | Mismo trade-off ya aceptado (`SmartOltHttpGateway`, `portalKillSwitch`). El margen que abre es de segundos de gasto, no de órdenes de magnitud; el `send` re-lee y el peor caso es un lote que arranca y se corta — no peor que hoy, que ni siquiera mira |
| **Sin reserva atómica: dos `send` concurrentes pasan el guard con el mismo saldo** | Media | NO resuelto por diseño (ningún use case del repo reserva cupo). El gate limita el caso normal, no la carrera; documentado. Un lock de reserva sería desviación de patrón sin justificación fuerte |
| Categoría ausente ⇒ tarifa equivocada | Media | Se tarifa como MARKETING (la más cara): puede SOBRE-estimar y bloquear de más, nunca sub-estimar y gastar de más. `categoryAssumed: true` lo hace visible |
| `category` de `/ContentAndApprovals` ≠ `approvalCategory` de `/ApprovalRequests` | Baja | Son 2 endpoints distintos sin garantía verificada de igualdad. Se acepta el de menor costo; si aparece drift, el fix es cambiar la fuente en UN lugar |
| Punto flotante en lotes de 500 | Media | Punto fijo de 4 decimales (enteros) en toda la aritmética; la comparación NUNCA toca `Number` flotante |
| Cuenta Twilio no-USD | Baja | No se convierte: moneda distinta ⇒ 503 explícito. Asunción USD EXPLÍCITA, no implícita |
| Tarifas desactualizadas vs. Meta | Alta | Son editables desde la card FE sin deploy; el número es una ESTIMACIÓN declarada, no una factura |
| Twilio `Balance.json` caído bloquea TODOS los envíos | Baja | Consecuencia deliberada del fail-closed en `send`; `validate` sigue funcionando (advisory) para no dejar ciego al operador |
| `app.ts` como punto de colisión | Media | Wiring self-contained en un bloque propio; test de composition-root del mount nuevo |

## Rollback Plan

1. **Sin deploy**: subir las tarifas a `0` desde Config → WhatsApp ⇒ `estimatedCost = 0` ⇒ el guard
   nunca rechaza (queda inerte). El kill-switch existente sigue apagando todo el bulk.
2. Revert del mount de `messagingRatesConfig.routes.ts` y del `GET /credit` en `app.ts`: las rutas
   dejan de existir, nada más las referencia.
3. La tabla `MessagingRatesConfig` y `ExternalBulkPreview.credit` son aditivas y nullable: quedan
   inertes sin migración inversa. Los previews vivos NO se invalidan (el `payloadHash` no cambió).

## Dependencies

- Cuenta Twilio alcanzable en `api.twilio.com` (si no, 503 explícito en `send`).
- `config.twilio.accountSid`/`authToken` ya configurados (opt-in existente, sin fail-fast).
- FE `ipnext-frontend` para la card de tarifas (coordinado, no bloqueante).

## Success Criteria

- [ ] `validate` devuelve `credit` con `available`, `unitCost`, `estimatedCost`, `sufficient` y la `category` usada.
- [ ] Crédito insuficiente en `validate` → **200** con `sufficient=false` + `warnings:['INSUFFICIENT_CREDIT']` (NO 4xx).
- [ ] Balance caído en `validate` → **200** con `credit.unknown=true` + `warnings:['CREDIT_UNAVAILABLE']`.
- [ ] `send` con crédito insuficiente → **422** `INSUFFICIENT_CREDIT` con `{available, estimatedCost, currency}` y **cero** `Campaign` creada.
- [ ] `send` con balance inalcanzable o moneda ≠ config → **503** `CREDIT_UNAVAILABLE`, cero `Campaign`.
- [ ] Replay (misma `Idempotency-Key`, campaña ya creada) NO re-chequea crédito ni falla por saldo.
- [ ] Template sin categoría → tarifado como MARKETING + `categoryAssumed=true`.
- [ ] El `payloadHash` de un preview es IDÉNTICO antes y después de este change (no-regresión pineada por test).
- [ ] Segunda llamada dentro de los 60 s → `cached=true` y **una sola** request HTTP a Twilio.
- [ ] `GET/PUT /api/messaging/config/rates` con `messaging:read`/`messaging:manage`; tarifa negativa o de 5 decimales → 400.
- [ ] `npm test` verde + `tsc --noEmit`; review adversarial 0 CRITICAL / 0 HIGH.

## Phases

1. **BE** (este worktree): schema + ports + adapters + use cases + rutas + tests (TDD estricto).
2. **FE** (`ipnext-frontend`, worktree paralelo): card de tarifas + saldo vivo en Config → WhatsApp.
3. **Skill** (posterior): sección "Crédito" en `whatsapp-bulk-ipnext`, recién después de verificación en vivo.

## Open Questions

Ninguna. Las 4 aperturas de la exploración quedan cerradas acá: `category` de `listTemplates`,
port segregado + gateway propio, categoría ausente ⇒ MARKETING fail-safe, y moneda USD como
asunción EXPLÍCITA con 503 ante mismatch.
