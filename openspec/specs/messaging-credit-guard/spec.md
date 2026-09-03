# Spec — messaging-credit-guard (new capability)

RFC-2119. Capacidad NUEVA: saldo del proveedor Twilio + tarifas configurables + estimación de
costo en punto fijo, con `validate` advisory y `send` fail-closed. No reabre `external-bulk-messaging`
(ver delta en ese domain) ni `messaging-bulk`. Cada scenario debe quedar cubierto por al menos un
test Jest verde (sdd-verify arma la matriz spec↔test).

## Purpose

Antes de este change, `validate`/`send` de la API Externa reportan conteos pero nunca plata: una IA
puede autorizar un lote sin saber si la cuenta Twilio tiene saldo. Esta capacidad agrega el puerto
de balance, el singleton de tarifas por categoría de template, y las reglas de costo/gate que usan
`external-bulk-messaging` (`validate`/`send`) y un endpoint de solo-lectura (`GET /credit`).

---

## Capability: RATES — tarifas configurables por categoría

### Requirement: RATES-1 — singleton con defaults
`MessagingRatesConfig` MUST ser fila única (`id:'singleton'`) con `currency` (3 letras, default
`"USD"`), `utilityRate` (Decimal, default `0.0120`), `marketingRate` (default `0.0618`),
`authenticationRate` (default `0.0220`), `providerFee` (default `0.0050`), `updatedAt`. La fila se
crea de forma LAZY en la primera lectura/escritura (molde `ExternalBulkMessagingConfig`), nunca con
backfill de migración.

#### Scenario: primera lectura sin config previa
- Given ninguna fila de `MessagingRatesConfig` creada aún
- When se resuelve la config para `validate`/`send`/`GET /credit`
- Then usa los 5 defaults documentados, sin fallback hardcodeado fuera del repo

### Requirement: RATES-2 — validación de las tarifas (PUT)
`PUT /api/messaging/config/rates` MUST rechazar cualquier tarifa negativa o con más de 4
decimales, y MUST rechazar `currency` que no sean exactamente 3 letras mayúsculas — 400
`VALIDATION_ERROR`, sin persistir.

#### Scenario: tarifa negativa
- Given `PUT` con `{utilityRate: -0.01, ...}`
- When se ejecuta
- Then responde 400 `VALIDATION_ERROR`, la config no cambia

#### Scenario: más de 4 decimales
- Given `PUT` con `{marketingRate: 0.06185}`
- When se ejecuta
- Then responde 400 `VALIDATION_ERROR`

#### Scenario: currency inválida
- Given `PUT` con `{currency:"us"}` (minúscula) o `{currency:"USDD"}`
- When se ejecuta
- Then responde 400 `VALIDATION_ERROR`

#### Scenario: update válido
- Given `PUT` con `{currency:"USD", utilityRate:0.015, marketingRate:0.07,
  authenticationRate:0.025, providerFee:0.006}` y `messaging:manage`
- When se ejecuta
- Then responde 200 FLAT (sin envelope) con las 5 tarifas + `updatedAt`; `validate`/`send`
  subsiguientes las usan

### Requirement: RATES-3 — GET/PUT gateados por permiso
`GET /api/messaging/config/rates` MUST requerir `messaging:read`; `PUT` MUST requerir
`messaging:manage` (molde `externalBulkMessagingConfig.routes.ts`), sesión (no api-key).

#### Scenario: GET sin messaging:read
- Given un usuario admin sin `messaging:read`
- When `GET /api/messaging/config/rates`
- Then responde 403

#### Scenario: PUT con messaging:read pero sin messaging:manage
- Given un usuario con `messaging:read` pero sin `messaging:manage`
- When `PUT /api/messaging/config/rates`
- Then responde 403, la config no cambia

---

## Capability: BALANCE — saldo del proveedor

### Requirement: BAL-1 — puerto segregado `CreditBalancePort`
El sistema MUST exponer `CreditBalancePort.getBalance(): Promise<{amount, currency, fetchedAt}>`,
implementado por `TwilioCreditBalanceGateway` contra
`GET https://api.twilio.com/2010-04-01/Accounts/{sid}/Balance.json` con Basic auth
(`config.twilio.accountSid/authToken`), y por `InMemoryCreditBalancePort` para tests — el use case
de crédito MUST NOT depender del SDK de Twilio directo.

#### Scenario: balance leído del proveedor real (adapter)
- Given credenciales Twilio válidas configuradas
- When `TwilioCreditBalanceGateway.getBalance()` corre contra `Balance.json`
- Then devuelve `{amount, currency, fetchedAt}` parseado desde la respuesta HTTP 200

### Requirement: BAL-2 — parseo en punto fijo de 4 decimales
El `balance` de Twilio (string, ej. `{"balance":"17.894","currency":"USD"}`) MUST parsearse a un
entero de punto fijo de 4 decimales (1/10000) — NUNCA a `Number` flotante para la comparación
posterior.

#### Scenario: balance de muestra en vivo
- Given la respuesta `{"balance":"17.894","currency":"USD"}`
- When se parsea
- Then el monto interno es `178940` (17.894 × 10000), `currency:"USD"`

### Requirement: BAL-3 — cache single-slot TTL 60s
El gateway MUST cachear el último balance leído en un único slot `{value, expiresAt} | null`
(cardinalidad 1, no un `Map`) con reloj inyectable, TTL `60_000` ms (molde `SmartOltHttpGateway`).
Dentro de la ventana, MUST servir el valor cacheado sin request HTTP nuevo.

#### Scenario: segunda lectura dentro de los 60s
- Given una lectura previa hace 30s
- When se pide el balance de nuevo (`validate`, `send`, o `GET /credit`)
- Then se sirve el valor cacheado, `cached:true`, CERO request HTTP nuevo a Twilio

#### Scenario: lectura después de vencido el TTL
- Given una lectura previa hace 61s
- When se pide el balance de nuevo
- Then se dispara un request HTTP nuevo a `Balance.json`

### Requirement: BAL-4 — balance inalcanzable → error tipado
Timeout, 5xx, o cualquier falla de red/auth contra `Balance.json` MUST mapearse a
`CreditUnavailableError` (molde `ChatwootUnavailableError`/`TemplateProviderUnavailableError`) —
nunca un throw sin tipar ni un `undefined` silencioso.

#### Scenario: Balance.json cae con timeout
- Given `TwilioCreditBalanceGateway.getBalance()` excede el timeout
- When se invoca desde `validate`, `send`, o `GET /credit`
- Then el use case recibe `CreditUnavailableError`, nunca una excepción sin tipar

---

## Capability: COST — estimación de costo en punto fijo

### Requirement: COST-1 — unitCost = tarifa de categoría + fee del proveedor
`unitCost = rate(category) + providerFee`, donde `rate` selecciona
`utilityRate|marketingRate|authenticationRate` según `template.category`
(`UTILITY|MARKETING|AUTHENTICATION`).

#### Scenario: template UTILITY con defaults
- Given `template.category === 'UTILITY'` y las tarifas default
- When se calcula `unitCost`
- Then `unitCost = 0.0120 + 0.0050 = 0.0170`

### Requirement: COST-2 — categoría ausente/desconocida ⇒ MARKETING + `categoryAssumed`
Si `template.category` es `undefined` o no pertenece al enum conocido, el sistema MUST tarifar
como `MARKETING` (la tarifa más cara, fail-safe: nunca subestima) y MUST marcar
`credit.categoryAssumed: true`.

#### Scenario: template sin categoría resuelta
- Given un template `pending`/`unsubmitted` con `category: undefined`
- When se calcula el costo
- Then `unitCost` usa `marketingRate + providerFee` y `credit.categoryAssumed === true`

### Requirement: COST-3 — estimatedCost en punto fijo
`estimatedCost = validCount × unitCost`, calculado ENTERAMENTE en enteros de 1/10000 (nunca
`Number` flotante en la multiplicación ni en la comparación); el redondeo half-up a 4 decimales
MUST aplicarse solo para la representación mostrada al caller.

#### Scenario: lote de 500 sin arrastre de punto flotante
- Given `validCount = 500` y `unitCost = 0.0170` (UTILITY)
- When se calcula `estimatedCost`
- Then el resultado entero es determinístico (`85000` en 1/10000 = `8.5000`)

### Requirement: COST-4 — comparación de suficiencia y mismatch de moneda
`sufficient = available >= estimatedCost`, comparado en enteros de punto fijo. Si la `currency`
del balance difiere de la `currency` de `MessagingRatesConfig`, el resultado MUST ser `unknown`
(no se compara a ciegas entre monedas).

#### Scenario: saldo suficiente en el límite exacto
- Given `available = 8.50` USD y `estimatedCost = 8.50` USD (rates en USD)
- When se compara
- Then `sufficient === true` (`>=`, el límite exacto pasa)

#### Scenario: moneda del balance distinta a la de la config
- Given `MessagingRatesConfig.currency === 'USD'` y el balance responde `currency:'ARS'`
- When se calcula `credit`
- Then el resultado es `unknown:true` (no se compara ARS contra USD)

---

## Capability: VALIDATE — advisory en el preview

### Requirement: CG-VAL-1 — el bloque `credit` viaja siempre, 200
`validate` MUST incluir `credit: {available, currency, category, unitCost, estimatedCost,
sufficient, categoryAssumed?, unknown?}` en la respuesta 200, y MUST agregar
`warnings: ['INSUFFICIENT_CREDIT']` cuando `sufficient === false` o
`warnings: ['CREDIT_UNAVAILABLE']` cuando el balance no se pudo leer. Insuficiente o inalcanzable
MUST NOT convertir la respuesta en un error.

#### Scenario: crédito insuficiente en validate
- Given `estimatedCost > available`
- When `POST .../validate`
- Then responde 200 con `credit.sufficient:false` y `warnings:['INSUFFICIENT_CREDIT']` (NUNCA 4xx)

#### Scenario: balance inalcanzable en validate
- Given `CreditBalancePort.getBalance()` lanza `CreditUnavailableError`
- When `POST .../validate`
- Then responde 200 con `credit.unknown:true` y `warnings:['CREDIT_UNAVAILABLE']`

### Requirement: CG-VAL-2 — el crédito se persiste en el snapshot, FUERA del `payloadHash`
El bloque `credit` calculado en `validate` MUST persistirse en `ExternalBulkPreview` (columna
`credit Json?`) como evidencia de "qué se le mostró a quien autorizó", pero MUST NOT participar
del cálculo del `payloadHash` — es dato del proveedor/config, no input del caller.

#### Scenario: el hash no cambia si las tarifas cambian entre dos previews del MISMO payload
- Given un preview P1 con `payloadHash = H`, creado con las tarifas vigentes
- When se cambian las tarifas (`PUT /config/rates`) y se crea P2 con el MISMO payload de
  recipients/template/variables
- Then `P2.payloadHash === H` aunque `P2.credit.unitCost` sea distinto

---

## Capability: SEND — gate fail-closed

### Requirement: CG-SEND-1 — re-chequeo con saldo FRESCO contra los destinatarios del preview
`send` MUST recalcular `credit` ANTES de crear la `Campaign` y ANTES de consumir el preview, con:

- **balance FRESCO obligatorio** (`getBalance({fresh:true})`): la cache de 60 s de BAL-3 NO es
  válida acá. El flujo normal es `validate` (que llena la cache) → `send` segundos después, con lo
  cual la cache serviría SIEMPRE el saldo PRE-gasto (fix wave F1, F1);
- **`validCount` = `preview.recipients.length`**, o sea los destinatarios del PREVIEW.

Tras un `send` ACEPTADO (campaña creada + runner arrancado), `send` MUST invalidar la cache del
port, para que el próximo `validate` no muestre el saldo de antes del gasto.

**Nota de exactitud (fix wave F1, R2 #1)** — el conteo del gate es el del PREVIEW, no el de los
destinatarios finalmente autorizados. `CreateCampaign` re-resuelve opt-outs por su cuenta (SEND-4),
así que un opt-out ocurrido ENTRE `validate` y `send` hace que el gate SOBRE-estime en un
destinatario. El sesgo es deliberado y va siempre para el mismo lado: el gate puede bloquear de más,
NUNCA de menos. La alternativa (contar después de `CreateCampaign`) exigiría chequear el crédito
DESPUÉS de crear la campaña, es decir después del side-effect que el gate existe para prevenir.

#### Scenario: la cache del validate NO se usa para decidir
- Given un `validate` que dejó el saldo 10.0000 en la cache de 60 s del port
- And el saldo REAL cayó a 0.0000 por fuera
- When `POST .../send` a los 30 segundos (cache todavía vigente)
- Then el gate lee el saldo del PROVEEDOR (no la cache) y responde 422 `INSUFFICIENT_CREDIT`

#### Scenario: tras un send aceptado la cache queda invalidada
- Given un `send` que resultó 202 (campaña creada, runner arrancado)
- When el siguiente `validate` pide el balance
- Then el port va al proveedor de nuevo (el slot fue invalidado), no sirve el saldo pre-gasto

#### Scenario: el gate cobra los destinatarios del preview (sobre-estima, nunca sub-estima)
- Given un preview con 10 `valid`, uno dado de baja DESPUÉS del `validate`
- When `POST .../send`
- Then el gate tarifa 10 destinatarios (los del preview); `CreateCampaign` crea 9 — el guard
  bloqueó contra un costo MAYOR o igual al real, nunca menor

#### Scenario: el costo escala con N (no es el costo unitario)
- Given un preview con 500 destinatarios y `unitCost` 0.0668
- When `POST .../send` con saldo 33.3999
- Then responde 422 con `estimatedCost: "33.4000"` (500 × 0.0668), no "0.0668"

### Requirement: CG-SEND-6 — dos `send` concurrentes no sobregiran
El tramo gate de crédito → `CreateCampaign` → `markConsumed` → arranque del runner MUST correr
serializado dentro del proceso. Dos `send` simultáneos NO pueden pasar ambos el gate leyendo el
mismo saldo.

Alcance DECLARADO: la protección es de instancia única (mutex en proceso), no de cluster —
`CampaignRunner` ya es uno por proceso por diseño (D6). Escalar a N instancias exige subir el
candado a un advisory lock de Postgres (D10.b).

#### Scenario: dos lotes de 8 USD con 10 USD de saldo
- Given saldo 10.0000 y dos `send` lanzados a la vez, cada uno con costo estimado 8.0000
- When ambos se ejecutan concurrentemente
- Then exactamente UNO responde 202 y el otro 422 `INSUFFICIENT_CREDIT`; se crea UNA sola `Campaign`

### Requirement: CG-SEND-2 — insuficiente ⇒ 422, cero side-effects
Si el re-chequeo da `estimatedCost > available`, `send` MUST responder 422
`INSUFFICIENT_CREDIT` con `{available, estimatedCost, currency}`, y MUST NOT crear `Campaign` ni
marcar el preview como consumido.

#### Scenario: saldo insuficiente al momento del send
- Given un preview `valid`, saldo caído por debajo del costo estimado DESPUÉS del `validate`
- When `POST .../send`
- Then responde 422 `INSUFFICIENT_CREDIT` con `{available, estimatedCost, currency}`; CERO
  `Campaign` creada; el preview sigue `consumedAt: null`

### Requirement: CG-SEND-3 — inalcanzable o mismatch de moneda ⇒ 503, fail-closed
Si el balance no se puede leer, o su `currency` difiere de la de `MessagingRatesConfig`, `send`
MUST responder 503 `CREDIT_UNAVAILABLE`, sin crear `Campaign`.

#### Scenario: Balance.json caído en el momento del send
- Given `CreditBalancePort.getBalance()` lanza `CreditUnavailableError` durante `send`
- When `POST .../send`
- Then responde 503 `CREDIT_UNAVAILABLE`, CERO `Campaign` creada

#### Scenario: moneda distinta en el momento del send
- Given el balance responde `currency:'ARS'` y la config está en `'USD'`
- When `POST .../send`
- Then responde 503 `CREDIT_UNAVAILABLE`, CERO `Campaign` creada

### Requirement: CG-SEND-4 — el replay NO re-chequea crédito
Un `send` de replay (misma `Idempotency-Key`, campaña ya creada, molde SEND-6 de
`external-bulk-messaging`) MUST NOT re-chequear crédito — la plata ya está comprometida, mismo
criterio que los caps.

#### Scenario: replay tras un send exitoso
- Given un `send` exitoso previo con `Idempotency-Key=K1`, `campaignId=C1`
- When se repite `POST .../send` con `K1`
- Then responde 200 idempotente (SEND-6), sin volver a leer el balance ni recalcular costo

### Requirement: CG-SEND-5 — tarifas en cero ⇒ guard inerte
Si las 4 tarifas (`utilityRate`, `marketingRate`, `authenticationRate`, `providerFee`) están en
`0`, `unitCost` y `estimatedCost` MUST ser `0`, y el guard MUST NUNCA rechazar por crédito
(rollback operativo sin deploy, documentado en el proposal).

#### Scenario: tarifas puestas en cero
- Given `MessagingRatesConfig` con las 4 tarifas en `0`
- When `POST .../send` con cualquier cantidad de destinatarios
- Then `estimatedCost === 0`; el guard nunca bloquea por crédito

---

## Capability: CREDIT — endpoint de solo lectura

### Requirement: CRED-1 — `GET /credit` expone saldo + tarifas sin disparar nada
`GET /api/external/v1/messaging/bulk/credit` (misma key dedicada y kill-switch de
`external-bulk-messaging`) MUST responder 200 con `{available, currency, fetchedAt, cached:
boolean, rates:{currency, utilityRate, marketingRate, authenticationRate, providerFee}}`, MUST NOT
crear ningún `Campaign`/`ExternalBulkPreview` — solo lectura.

#### Scenario: lectura de saldo y tarifas vigentes
- Given credenciales Twilio configuradas y `MessagingRatesConfig` con las tarifas vigentes
- When `GET .../credit` con la key dedicada
- Then responde 200 con `available`, `currency`, `fetchedAt`, `cached`, y las 4 tarifas + su
  `currency` en `rates`

### Requirement: CRED-2 — balance inalcanzable ⇒ 503
Si el balance no se puede leer, `GET /credit` MUST responder 503 `CREDIT_UNAVAILABLE` (mismo error
tipado que BAL-4).

#### Scenario: Twilio caído al consultar /credit
- Given `CreditBalancePort.getBalance()` lanza `CreditUnavailableError`
- When `GET .../credit`
- Then responde 503 `CREDIT_UNAVAILABLE`

---

## Capability: AUDIT

### Requirement: CG-AUDIT-1 — rechazo por crédito se audita como cualquier otro rechazo
Un `send` rechazado por `INSUFFICIENT_CREDIT` (422) o `CREDIT_UNAVAILABLE` (503) MUST dejar el
mismo registro de auditoría que cualquier otro rechazo de `send` (molde AUDIT-1 de
`external-bulk-messaging`: `actorLogin:'api-messaging'`, `actorId` no nulo, outcome del rechazo).

#### Scenario: rechazo por crédito insuficiente queda auditado
- Given un `send` que resulta en 422 `INSUFFICIENT_CREDIT`
- When se procesa el request
- Then queda un registro de auditoría con `actorLogin:'api-messaging'` y el outcome del rechazo
  (mismo criterio que `CAP_EXCEEDED`)

---

## Capability: KILL-SWITCH / AUTH del endpoint nuevo

### Requirement: CG-AUTH-1 — `GET /credit` detrás de la MISMA key dedicada y el MISMO kill-switch
`GET /credit` MUST estar detrás de `X-Api-Key` dedicada (AUTH-1/2/3 de `external-bulk-messaging`)
y del flag `messaging-external-bulk-enabled` (KS-1) — ninguna exención propia.

#### Scenario: sin key → 401
- Given un request sin `X-Api-Key`
- When `GET .../credit`
- Then responde 401 `UNAUTHORIZED`, sin llamar a Twilio

#### Scenario: key global no abre /credit
- Given `X-Api-Key` = la key GLOBAL de `/api/external/v1`
- When `GET .../credit`
- Then responde 401 `UNAUTHORIZED`

#### Scenario: flag OFF apaga /credit
- Given el flag `messaging-external-bulk-enabled` en `false`
- When `GET .../credit` con la key dedicada válida
- Then responde 403 `FEATURE_DISABLED`, sin llamar a Twilio

### Requirement: CG-AUTH-2 — el kill-switch NO apaga la lectura de saldo del ADMIN
`GET /api/messaging/config/rates/balance` (router admin, sesión + `messaging:read`) MUST seguir
respondiendo con el flag `messaging-external-bulk-enabled` en `false`.

Asimetría DELIBERADA respecto de CG-AUTH-1 (fix wave F1, R2 #8): el kill-switch apaga el ENVÍO
M2M, no la capacidad del operador de mirar cuánto saldo hay — que es justamente lo primero que uno
quiere ver cuando acaba de apagar los envíos.

#### Scenario: flag OFF, la card de admin sigue viendo el saldo
- Given el flag `messaging-external-bulk-enabled` en `false`
- When `GET /api/messaging/config/rates/balance` con sesión y `messaging:read`
- Then responde 200 con el saldo (mientras `GET .../external/v1/...//credit` responde 403)

## Capability: PERILLA PROPIA DEL GUARD (fix wave F1, F7)

### Requirement: CG-FLAG-1 — feature flag `messaging-credit-guard-enabled`
El guard de crédito MUST tener una perilla PROPIA, independiente del kill-switch de la API externa.
La fila nace en **`true`** desde la migración de este change.

Semántica INVERSA a la de KS-1: la ausencia de la fila y cualquier error del repo de flags MUST
resolver a **ON** (fail-closed) — una protección no se apaga sola porque la DB tosió. Solo la apaga
un operador poniendo la fila en `false` a propósito, con el `PATCH /api/admin/feature-flags/:key`
genérico que ya existe (gate `admin.flags`, cero trabajo de FE).

Con el flag en OFF:
- `validate` MUST devolver `credit.unknown: true` con `unitCost: null`, `estimatedCost: null` y
  `warnings: ["CREDIT_GUARD_DISABLED"]`, y MUST NOT pegarle al proveedor ni leer tarifas;
- `send` MUST SALTEAR el gate por completo (fail-OPEN por decisión explícita del operador),
  incluida la lectura del balance.

El kill-switch general sigue mandando: con `messaging-external-bulk-enabled` en OFF, el `send`
responde 403 `FEATURE_DISABLED` aunque el guard esté apagado.

#### Scenario: flag OFF ⇒ validate no mide y lo dice
- Given `messaging-credit-guard-enabled` en `false`
- When `POST .../validate` con un lote válido
- Then responde 200 con `credit.unknown: true`, `unitCost: null`, `estimatedCost: null` y
  `warnings: ["CREDIT_GUARD_DISABLED"]`, sin ninguna request al proveedor

#### Scenario: flag OFF ⇒ send envía aunque no haya saldo
- Given `messaging-credit-guard-enabled` en `false` y saldo 0.0000
- When `POST .../send` sobre un preview válido
- Then responde 202 y NO se consulta el balance del proveedor

#### Scenario: la fila del flag no existe ⇒ guard PRENDIDO
- Given ninguna fila `messaging-credit-guard-enabled` en `FeatureFlag`
- When `POST .../send` con saldo insuficiente
- Then responde 422 `INSUFFICIENT_CREDIT` (el guard corrió)

#### Scenario: el repo de flags revienta ⇒ guard PRENDIDO
- Given `featureFlags.get('messaging-credit-guard-enabled')` lanza
- When `POST .../send` con saldo insuficiente
- Then responde 422 `INSUFFICIENT_CREDIT` (fail-closed, nunca fail-open por error)

## Capability: CONTRATO DE WIRE DEL BLOQUE `credit` (fix wave F1, F8)

### Requirement: CG-WIRE-1 — `unitCost`/`estimatedCost` son nullable
Cuando el COSTO no se puede resolver (fila de tarifas ilegible, repo de tarifas caído, overflow de
punto fijo, guard apagado), `unitCost` y `estimatedCost` MUST viajar `null` — NUNCA `"0.0000"`. Un
cero es un número, y quien lo lee (card FE, IA que consume la API externa) lo interpreta como
"gratis".

Cuando lo que falla es el SALDO (balance inalcanzable, moneda distinta), el bloque igual viaja
`unknown: true` con `available: null`, pero `unitCost`/`estimatedCost` MUST seguir siendo números:
el costo sí se conoce y es información útil.

#### Scenario: tarifa ilegible ⇒ costos null
- Given `marketingRate` = `"not-a-number"` en la fila de tarifas
- When `POST .../validate`
- Then responde 200 con `credit.unitCost: null`, `credit.estimatedCost: null`, `unknown: true`

#### Scenario: balance inalcanzable ⇒ costos SÍ presentes
- Given el proveedor caído, tarifas legibles, 3 destinatarios válidos
- When `POST .../validate`
- Then responde 200 con `available: null`, `unknown: true`, `unitCost: "0.0668"` y
  `estimatedCost: "0.2004"`
