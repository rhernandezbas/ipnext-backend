# Exploration: twilio-credit-guard

> Ask (usuario, 2026-09-02): antes de autorizar un envío masivo por la API
> Externa, chequear el saldo de la cuenta Twilio y estimar el costo del lote
> por CATEGORÍA de template; `validate` marca crédito insuficiente en el
> preview; `send` no debe gastar plata que no tiene. Defaults del orquestador
> (costo = válidos × (tarifa Meta por `approvalCategory` + fee Twilio),
> config editable, balance vía `GET .../Balance.json` con cache ~60s,
> fail-closed en `send`) se adoptan salvo que el código diga lo contrario —
> este documento los contrasta contra el código real.

## Resumen ejecutivo

- **`template.category` YA está disponible en `validate` sin ninguna llamada
  extra a Twilio.** `ValidateExternalBulk.execute()` resuelve el template vía
  `this.templatePort.listTemplates()` (`ValidateExternalBulk.ts:100`), y
  `TwilioContentGateway.listTemplates()` puebla `category` desde
  `item.approval_requests?.category` del propio `GET
  /v1/ContentAndApprovals` (`TwilioContentGateway.ts:453`,
  `toTemplateDto`) — confirmado por el fixture del test
  (`TwilioContentGateway.test.ts:73`: `category: 'UTILITY'` en un item
  `approved` de `listTemplates`). El campo DISTINTO `approvalCategory`
  (`TemplateMessagingPort.ts:38-44`) sí requiere el segundo GET a
  `.../ApprovalRequests` y SOLO lo puebla `getTemplate(sid)`
  (`TwilioContentGateway.ts:457`) — pero el ask pide la categoría MARKETING/
  UTILITY/AUTHENTICATION para tarifar, y esa ya viaja en `category` desde
  `listTemplates`. **Conclusión: usar `template.category`, cero llamada
  adicional, cero latencia nueva en `validate`/`send`.** Si `category` viene
  `undefined` (template `pending`/`unsubmitted` sin categoría todavía — ver
  `TwilioContentGateway.test.ts:74`), el estimador no tiene con qué tarifar:
  hay que decidir en `sdd-propose`/`design` si eso es 422 (config incompleta)
  o si se asume una categoría default (riesgoso — puede subestimar costo).
- **El molde de "config singleton editable + card FE" está probado DOS veces
  en este mismo dominio (`external-bulk-messaging`) y es 100% reusable tal
  cual** — `ExternalBulkMessagingConfig` (Prisma `id:'singleton'`,
  `schema.prisma:4273-4278`) + `ExternalBulkMessagingConfigRepository`
  (`get()`/`set()`, defaults en código) + `InMemory*`/`Prisma*` (molde exacto
  `FinanceReceiptSyncConfigRepository`) + router `/api/messaging/config/
  external-bulk` (sesión, NO api-key, `messaging:read`/`messaging:manage`,
  `externalBulkMessagingConfig.routes.ts`) + mount self-contained en
  `app.ts:3776-3788` + card FE `ExternalBulkMessagingCard.tsx` en
  `ipnext-frontend`. El singleton nuevo (`TwilioCreditConfig` o similar, con
  `utilityRate`/`marketingRate`/`authenticationRate`/`twilioFeePerMessage`)
  puede clonar ESTE molde línea por línea — es la SEGUNDA vez que este patrón
  se usa en el dominio de mensajería (la primera fue
  `WhatsappTaskStageTransitionConfig`/`FinanceReceiptSyncConfig`, la tercera
  es esta).
- **No hay ningún cliente Twilio que hable con `api.twilio.com/2010-04-01/
  Accounts/{sid}/Balance.json` hoy** (`grep` sin resultados) — es superficie
  100% nueva, pero el HOST y el auth YA son el mismo patrón: `apiBaseUrl`
  default `https://api.twilio.com` (`TwilioContentGateway.ts:34`, el MISMO
  host que ya usa `sendTemplate()`) + Basic auth `{accountSid, authToken}`
  (`TwilioContentGateway.ts:84-86`, método `auth()` ya existe y es
  reusable). El gateway se construye HOY 3 veces en `app.ts`
  (`app.ts:3318`, `:3471` [`templatePort`, el que usa `ValidateExternalBulk`/
  `SendExternalBulk`], `:3674`) — cada instancia SOLO recibe
  `{accountSid, authToken, messagingServiceSid}`, sin overrides de baseUrl.
  La forma más barata de agregar `getBalance()` es un método NUEVO en
  `TwilioContentGateway` (mismo `http`/`auth()`/`apiBaseUrl` ya cableados,
  cero gateway nuevo) expuesto por un port SEGREGADO
  (`TwilioBalancePort`/`TwilioCreditGateway`, ISP — mismo criterio que ya
  separa `TemplateMessagingPort` de `TemplateAdminPort` en este archivo) para
  no forzar al fake in-memory de tests (`InMemoryTemplateMessagingGateway`)
  a implementar algo que no necesita, salvo que el nuevo caso de uso SÍ lo
  necesite (entonces el fake shared lo implementa igual, siguiendo el molde
  de `TemplateAdminPort`).
- **El molde de cache TTL corto (~60s) YA existe, tres veces, en el mismo
  repo — reusar el patrón, no inventar uno.** `SmartOltHttpGateway` cachea
  `getOnuWifiStatus`/`getRouterHosts`/`getOnlineWifiMacs` con
  `Map<key, {value, expiresAt}>` + reloj inyectable `now: () => number`
  (`SmartOltHttpGateway.ts:28-52`, TTLs de `60_000` ms exactos — el MISMO
  número que pide el ask) y lee/escribe con `cached.expiresAt > this.now()`
  (líneas 442-462). Para el balance (una sola cuenta, no per-key) alcanza con
  un único slot `{value, expiresAt} | null` en vez de un `Map` — mismo
  criterio, cardinalidad 1. El otro precedente cercano es `IClassClient.
  nodesCacheTtlMs` (5 min) y `portalKillSwitchMiddleware.ts`'s
  `DEFAULT_CACHE_TTL_MS = 30_000`. Ninguno usa una librería de cache — todos
  son un objeto plano a mano, que es lo que corresponde acá también.
- **El `payloadHash` del preview NO debe incluir el crédito — confirmado por
  el propio contrato, no es una decisión nueva.** `externalBulkPayloadHash`
  (`ValidateExternalBulk.ts:169-180`, `SendExternalBulk.ts:328-336`) se
  computa SOLO sobre lo que el CALLER controla (`templateName`, `variables`,
  `chatwootLabel`, `recipients`) — es la defensa contra "el preview persistido
  fue mutado entre `validate` y `send`" (SEND-3, `PreviewPayloadMismatchError`).
  El crédito es un dato del PROVEEDOR/config, no un input del caller: mezclarlo
  en el hash rompería la re-hasheabilidad determinística en `send` (el balance
  a las 15:00 no es el balance a las 15:05, aunque el request sea IDÉNTICO) y
  el propio comentario D5 documenta que el set es "recipients ∪ invalid[].input"
  — nada de proveedor. El snapshot de crédito debe viajar en la RESPUESTA de
  `validate` (el ask lo pide: `credit: {...}`), no en `ExternalBulkPreview`
  persistido — es informativo/advisory, `send` re-chequea de cero (mismo
  criterio que el resto de SEND-4: template/label/caps se re-validan "contra
  el estado de AHORA", nunca contra lo que el preview dijo en su momento).
- **El molde de error 503 fail-closed para "proveedor no disponible" está
  probado 2 veces y es el que corresponde para `CREDIT_UNAVAILABLE`.**
  `ChatwootUnavailableError` (`domain/errors/messaging.ts:77`, 503) y
  `TemplateProviderUnavailableError`/`TemplateProviderConfigError`
  (`domain/errors/messaging-bulk.ts:22,58`, mapeadas 503/502-ish vía
  `statusMap`) son el precedente EXACTO: red/timeout/5xx del proveedor →
  error tipado de dominio → 503, nunca un throw sin mapear. `send`
  fail-closed ante `Balance.json` inalcanzable (ask: 503
  `CREDIT_UNAVAILABLE`) sigue el MISMO molde — un `CreditUnavailableError`
  nuevo en `domain/errors/external-bulk-messaging.ts` (junto a
  `ReporterUnavailableError`, que ya documenta el criterio "misconfiguración
  de plataforma, no error del caller") + entrada en el `statusMap` de
  `errorHandler.ts` (línea ~270, junto a `REPORTER_UNAVAILABLE: 503`).

## Affected areas (verificado, file:line)

- `src/application/use-cases/messaging/ValidateExternalBulk.ts:93-104,166-227` —
  punto de inserción del guard de crédito: DESPUÉS de resolver `template`
  (paso 4, ya tiene `template.category`) y DESPUÉS de calcular `valid.length`
  (paso 9, caps) — el orden natural es "caps de CANTIDAD primero (barato, en
  memoria/DB), costo de PLATA después" o viceversa; ninguno de los dos
  requiere tocar el otro. El use case YA recibe 9 dependencias por
  constructor — sumar `creditGateway`/`ratesConfigRepo` es el mismo patrón
  que ya usa (interfaces de dominio inyectadas, nunca el SDK de Twilio
  directo).
- `src/application/use-cases/messaging/SendExternalBulk.ts:138-155` — mismo
  punto de re-validación "contra el estado de AHORA" (SEND-4) donde hoy vive
  el re-chequeo de template/label/caps — el re-chequeo de crédito (ask:
  "`send` re-checks and rejects 422") entra ACÁ, con el mismo criterio de
  "re-leer, no confiar en el preview".
- `src/infrastructure/adapters/twilio/TwilioContentGateway.ts:63-86` —
  `auth()` y `apiBaseUrl` (`https://api.twilio.com`, ya default) son
  exactamente lo que necesita `GET .../Balance.json`; candidato natural para
  el método nuevo (o una clase hermana que reciba los mismos 2 args de auth).
- `src/domain/ports/TemplateMessagingPort.ts` — molde de ISP para segregar
  un port nuevo (`TwilioBalancePort` o similar) sin forzar el fake existente.
- `src/domain/ports/ExternalBulkMessagingConfigRepository.ts` +
  `prisma/schema.prisma:4273-4278` (`ExternalBulkMessagingConfig`) — molde
  EXACTO para el singleton de tarifas nuevo (`get()`/`set()`, defaults en
  código, `id:'singleton'`).
- `src/infrastructure/adapters/in-memory/InMemoryExternalBulkMessagingConfigRepository.ts` +
  `.../prisma/PrismaExternalBulkMessagingConfigRepository.ts` — molde
  copiable 1:1 (lazy singleton creation con `upsert({update:{}})`, fix wave
  F14 documentado — NO fabricar un `updatedAt` falso sin fila).
- `src/infrastructure/http/routes/externalBulkMessagingConfig.routes.ts` +
  mount en `app.ts:3776-3788` — molde de router de config (sesión,
  `messaging:read`/`messaging:manage`, SIN envelope `{data}`, respuesta
  FLAT) para `/api/messaging/config/twilio-credit` o similar.
- `src/infrastructure/http/app.ts:3318,3471,3674` — 3 instancias de
  `TwilioContentGateway`, todas construidas con SOLO
  `{accountSid, authToken, messagingServiceSid}` desde `config.twilio.*`; la
  de la línea `:3471` (`templatePort`) es la que inyectan
  `ValidateExternalBulk`/`SendExternalBulk` (`app.ts:3629-3649`) — si el
  balance se agrega como método del MISMO gateway, es la instancia natural a
  reusar (cero wiring nuevo); si se segrega a un port/clase distinta, hay que
  decidir si es una 4ª instancia self-contained (molde `templateAdminPort`,
  bloque "Change 3") o si se pasa el `http`/creds una vez más.
- `src/infrastructure/config.ts:663-667` — `config.twilio.*` ya expone
  `accountSid`/`authToken` (opt-in, sin fail-fast) — SUFICIENTE para
  `Balance.json` (Basic auth con las mismas credenciales, mismo criterio del
  ask). No hace falta ninguna env var nueva para el balance en sí.
- `src/infrastructure/adapters/smartolt/SmartOltHttpGateway.ts:28-52,441-463` —
  molde EXACTO de cache TTL corto in-memory (`{value, expiresAt}`, reloj
  inyectable) a clonar para el balance (cardinalidad 1, no `Map`).
- `src/domain/errors/external-bulk-messaging.ts` — junto a
  `CapExceededError`/`ReporterUnavailableError`: agregar
  `InsufficientCreditError` (422, molde `CapExceededError` con `details`
  tipados) y `CreditUnavailableError` (503, molde `ReporterUnavailableError`).
- `src/infrastructure/http/middleware/errorHandler.ts:260-270` — `statusMap`
  del bloque `external-bulk-messaging`, agregar
  `INSUFFICIENT_CREDIT: 422` y `CREDIT_UNAVAILABLE: 503`.
- `src/application/dto/external-bulk-messaging.dto.ts:78-90` —
  `ValidateExternalBulkOutput` — agregar el bloque `credit: {available,
  currency, unitCost, estimatedCost, sufficient, category, unknown?}` pedido
  por el ask, D12-style (shape EXACTO documentado igual que el resto del
  archivo).
- `src/infrastructure/http/routes/external-messaging.routes.ts:126-166` —
  las rutas `/validate`/`/send` ya montan sobre estos use cases sin cambios
  de firma esperables (el nuevo `GET /credit` del ask es una ruta HERMANA
  nueva en este mismo router, molde `GET /campaigns/:id` — sin rate limit,
  solo lectura).
- `ipnext-frontend/src/components/settings/ExternalBulkMessagingCard.tsx` +
  `WhatsappSettingsPage.tsx` — molde de card de config con inputs numéricos +
  validación cliente (`STRICT_INTEGER_RE`, cross-field `maxPerRequest <=
  maxPerDay`) para la card nueva de tarifas — pero esta vez con 4 campos
  DECIMALES (tasas), no enteros; el `STRICT_INTEGER_RE` de esa card NO sirve
  tal cual, hay que adaptar la regex a decimales (ver "Money handling"
  abajo). Repo FE está fuera del alcance de este agente (worktree
  `twilio-credit-guard-fe` ya en curso en paralelo).

## Money handling — convención del repo

- El repo usa `Decimal` de Prisma para TODO monto (`@db.Decimal(12,2)` para
  pesos/dólares con centavos, `@db.Decimal(12,4)`/`Decimal(6,3)` para
  cantidades/porcentajes de más precisión — `schema.prisma:184,325,798,2867`).
  **No existe ningún monto como `Float`/`Int` de centavos en el schema** —
  la convención es Decimal siempre, nunca floats para plata.
- Las tarifas del ask (`0.0120`, `0.0618`, `0.0220`, `0.0050` USD) tienen 4
  decimales — el molde más cercano es `monthlyRatePct Decimal
  @db.Decimal(6,3)` (`schema.prisma:2867`) o los `qty Decimal @db.Decimal(12,4)`
  — sugerido `Decimal(10,4)` para cada tarifa (12,4 sería sobre-dimensionado
  para una tarifa por-mensaje, pero es más barato copiar el patrón existente
  que inventar una precisión nueva).
- **En TypeScript** (fuera de Prisma), el repo NO usa una librería de
  decimales (`decimal.js`) en ningún lado tocado por esta exploración —
  los cálculos de plata que sí existen (`costoVentaArs`, etc.) viven
  enteramente en columnas Prisma, y las lecturas via `toEntity()` los
  convierten a `number` plano para el DTO (mismo patrón que `qty`/`amount`
  en otros repos Prisma de este codebase, no revisado línea por línea en esta
  exploración pero es el patrón dominante: `Number(row.amount)` o similar).
  **Riesgo real de punto flotante**: `validos * (tarifa + fee)` con floats de
  JS puede acumular error de redondeo en lotes grandes (500 destinatarios).
  El `sdd-design` debe decidir: redondear a N decimales en cada paso, o
  aceptar el error (montos de centavos de dólar, error irrelevante en la
  práctica salvo que el usuario pida precisión contable estricta). No hay
  precedente de "redondeo de plata" documentado en este repo para copiar.

## Approaches — dónde vive el crédito de Twilio

1. **Método nuevo `getBalance()` en `TwilioContentGateway` (mismo host/auth)**
   - Pros: cero clase nueva, reusa `http`/`auth()`/`apiBaseUrl` ya cableados;
     la instancia `templatePort` (`app.ts:3471`) ya la reciben
     `ValidateExternalBulk`/`SendExternalBulk` — si el método vive ahí, CERO
     wiring nuevo en `app.ts` (ni siquiera una 4ª instancia).
   - Cons: `TwilioContentGateway` ya implementa 2 ports (`TemplateMessagingPort`
     + `TemplateAdminPort`); agregar un 3er método fuera de esos ports exige
     un port NUEVO (`TwilioBalancePort`) que la clase implemente además — el
     fake in-memory de tests (`InMemoryTemplateMessagingGateway`) tendría que
     sumarlo también si algún test construye el fake completo (verificar
     alcance real en `sdd-design`/`sdd-tasks`).
   - Esfuerzo: Bajo.

2. **Clase/gateway nueva dedicada** (`TwilioBalanceGateway` o similar, propio
   port `CreditBalancePort`)
   - Pros: ISP más limpio — el use case de crédito depende SOLO de la
     interfaz de balance, sin arrastrar `TemplateMessagingPort`/
     `TemplateAdminPort`; más fácil de fakear en tests aislados sin tocar el
     fake de templates existente.
   - Cons: 4ª instancia en `app.ts` (o reconstrucción de `http`/auth
     duplicada) — el molde del bloque "Change 3" (`templateAdminPort`,
     `app.ts:3674`) ya muestra que instanciar un gateway self-contained
     adicional con las MISMAS creds es aceptado en este repo (no es un
     antipatrón acá), así que el costo es solo repetición de 3 líneas de
     config, no arquitectura nueva.
   - Esfuerzo: Bajo-Medio.

**Sugerencia (no vinculante)**: Opción 2 (port segregado, gateway propio)
— es más barato de testear de forma aislada (el fake del crédito no necesita
saber nada de templates) y el repo YA tolera instancias Twilio repetidas
(3 hoy, sería la 4ª) sin que eso se haya señalado como deuda en ningún lado.
La Opción 1 es válida si `sdd-design` prioriza cero wiring nuevo por sobre
la segregación.

## Riesgos y edge cases

- **Categoría ausente en el template** (`pending`/`unsubmitted`, `category`
  `undefined`): no hay tarifa que aplicar — `sdd-propose`/`design` debe
  decidir el comportamiento (422 vs degradar). Ninguna decisión tomada acá.
- **Cache de 60s entre `validate` y `send`**: el ask lo asume aceptable
  (mismo criterio que el resto del flujo — SEND-4 re-valida "contra el
  estado de AHORA", no contra un snapshot). Un `send` inmediatamente después
  de un `validate` puede leer el balance CACHEADO (hasta 60s de stale) — es
  el mismo trade-off que ya acepta el repo en otros TTLs de 60s
  (`SmartOltHttpGateway`), no es una novedad de riesgo.
- **Validaciones concurrentes (doble-cuenta)**: confirmado por el propio ask
  ("`validate` is advisory; `send` is the gate") — el `remainingToday`/cupo
  de cantidad YA tiene este mismo patrón (`resolveRemainingToday` se
  re-lee "FRESCO" en `send`, comentario `SendExternalBulk.ts:374`) — el
  crédito debe seguir el MISMO criterio: el gate real es el re-chequeo en
  `send`, no una reserva atómica en `validate`. Ningún use case de este repo
  reserva cupo hoy — sería una desviación de patrón, no recomendada sin
  justificación fuerte.
- **Moneda del balance vs moneda configurada**: el ask fija AR/USD para las
  tarifas pero Twilio devuelve `currency` en la respuesta del balance — si
  la cuenta NO es USD, comparar `estimatedCost` (calculado en USD) contra
  `balance` (en otra moneda) da un resultado incorrecto sin conversión. No
  hay conversión de moneda en ningún lado de este repo (`grep` no
  revisado exhaustivamente en esta exploración, pero ningún archivo tocado
  la menciona) — asumir cuenta USD es razonable (Twilio AR normalmente
  factura en USD) pero debe quedar como asunción EXPLÍCITA en el proposal,
  no implícita.
- **`Balance.json` con sub-cuentas**: el ask usa el MISMO
  `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` que ya usa el resto del gateway
  — si la cuenta configurada es una sub-cuenta, el endpoint sigue
  funcionando igual (Twilio lo soporta por diseño), sin cambio de código.
  No verificado contra una cuenta real en esta exploración (sin acceso a
  Twilio en este entorno).
- **Doble definición de "categoría"**: el DTO tiene `category` (viene de
  `listTemplates`, disponible siempre que el template esté aprobado) y
  `approvalCategory` (solo `getTemplate`). Para approved templates ambos
  deberían coincidir en teoría, pero NO hay garantía verificada en código de
  que `category` de `approval_requests` en `/ContentAndApprovals` sea
  IDÉNTICO al de `/ApprovalRequests` — son 2 endpoints distintos de Twilio.
  Usar `category` (ya disponible) es la elección de menor esfuerzo; si
  `sdd-design` quiere más certeza podría preferir `approvalCategory` vía
  `getTemplate`, pagando la llamada extra — trade-off explícito a resolver
  ahí, no acá.

## Tests/fakes a extender

- `src/infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway.ts`
  — si el balance se agrega como método de `TwilioContentGateway`/port
  compartido, este fake necesita implementarlo también (o el port se
  segrega, Approach 2, y un fake NUEVO chico basta).
- `src/__tests__/application/messaging/ValidateExternalBulk.test.ts` /
  `SendExternalBulk.test.ts` — construyen los use cases con TODAS sus
  dependencias in-memory/fake; sumar el nuevo `creditGateway`/`ratesRepo`
  fake es aditivo, mismo molde que las 9 dependencias actuales.
- `InMemoryExternalBulkMessagingConfigRepository`/
  `PrismaExternalBulkMessagingConfigRepository` — molde a clonar 1:1 para el
  repo de tarifas (mismo test suite shape,
  `InMemoryExternalBulkMessagingConfigRepository.test.ts`).
- `src/__tests__/infrastructure/external-messaging.routes.test.ts` — router
  test harness ya construye `ExternalMessagingRouterDeps` completo con fakes;
  el nuevo `GET /credit` se suma ahí con el mismo patrón.
- `src/__tests__/infrastructure/externalBulkMessagingConfig.routes.test.ts`
  — molde para el test del router de config nuevo.

## Ready for Proposal

**Sí**, con 4 decisiones abiertas para `sdd-propose`/`sdd-design` (ninguna
bloquea, todas tienen una sugerencia razonable arriba):

1. `category` (ya disponible en `listTemplates`, sin llamada extra,
   recomendado) vs `approvalCategory` (requiere `getTemplate`, más preciso
   pero más costoso) para tarifar.
2. Dónde vive `getBalance()`: método nuevo en `TwilioContentGateway`
   (Approach 1, cero wiring) vs gateway/port segregado nuevo (Approach 2,
   recomendado por ISP y testing aislado).
3. Qué hacer cuando el template no tiene categoría resuelta (422 vs
   degradar) — sin precedente en el repo, decisión de producto pura.
4. Asunción de moneda (USD) — debe quedar explícita en el proposal, no
   hay conversión de moneda en el repo para resolverlo de otra forma.

Ningún hallazgo de esta exploración requiere volver a preguntarle al
usuario — todas las decisiones abiertas tienen default razonable documentado.
