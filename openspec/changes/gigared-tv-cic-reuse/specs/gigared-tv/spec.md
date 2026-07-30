# Spec delta — capability `gigared-tv`

Formato: RFC 2119 + Given/When/Then. Sólo se listan requisitos AÑADIDOS o MODIFICADOS.

---

## ADDED — `CIC-1`: validez de formato de un CIC del pool

Un CIC del pool SÓLO es candidato si es **puramente numérico y no vacío**.

> **Decisión de diseño:** se valida la **clase de caracteres**, NO la **longitud**. Todos los CICs observados tienen 10 dígitos, pero fijar `^\d{10}$` haría que un eventual CIC de otra longitud emitido por el partner bloquee el 100% de las altas — exactamente el fallo que este change viene a arreglar. El modo de falla observado es un carácter no numérico; eso es lo que se rechaza.

- **CIC-1.1** — El sistema DEBE rechazar como candidato todo CIC que contenga cualquier carácter fuera de `[0-9]`.
- **CIC-1.2** — El sistema DEBE rechazar como candidato un CIC vacío, `null` o `undefined`.

**Escenario (el bug real):**
> **Given** el pool contiene una cuenta con `cic = "00065470 4"` (byte `0x20` en la posición 8) e `internal_id = null`
> **When** se solicita un alta de TV
> **Then** ese CIC NO DEBE ser elegido como candidato
> **And** el sistema NO DEBE llamar a `register` con él

---

## MODIFIED — `POOL-1`: filtro anti-envenenamiento del pool (refina B1)

**Antes:** un CIC era candidato sólo si `cic` era truthy y su `internal_id` estaba vacío. Todo CIC estampado se rechazaba.

**Ahora:** un CIC estampado PUEDE ser candidato si su identidad pertenece a un cliente nuestro **elegible para reutilización**.

- **POOL-1.1** — Un CIC con `internal_id` vacío (`null`, `undefined` o `''`) y formato válido DEBE clasificarse como **`limpio`**.
- **POOL-1.2** — Un CIC cuyo `internal_id` NO parsea al formato de identidad TV propio (`{uuid}` o `{uuid}-{seq}`) DEBE clasificarse como **`ajeno`** y NUNCA ser candidato.
- **POOL-1.3** — Un CIC cuyo `internal_id` parsea a un `clientId` que **no existe** en el mirror local DEBE clasificarse como **`ajeno`**.
- **POOL-1.4** — Un CIC cuyo `internal_id` parsea a un cliente nuestro que **NO** cumple la invariante de elegibilidad DEBE clasificarse como **`ajeno`**.
- **POOL-1.5** — Un CIC cuyo `internal_id` parsea a un cliente nuestro que **SÍ** cumple la invariante DEBE clasificarse como **`reutilizable`**.
- **POOL-1.6** — El sistema DEBE preferir SIEMPRE un candidato `limpio`. SÓLO si no existe ningún `limpio` PUEDE elegir uno `reutilizable`.
- **POOL-1.7** *(reescrito en la RONDA 4 — el código se había adelantado al spec)* — Ante la ausencia de candidatos, el sistema clasifica cada CIC descartado en **tres** cubetas y elige el error según ellas:

  | Cubeta | Qué la produce | Cuenta para |
  |---|---|---|
  | `ajenos` | identidad no parseable · cic malformado **pero estampado** · cliente no elegible | `poisonedCount` |
  | `ocupadas` | la cuenta del partner tiene datos (email/nombre/fecha/dispositivos) | `poisonedCount` |
  | `noVerificables` | la consulta al mirror falló · el shape del listado no trae los campos | — |

  - **POOL-1.7a** — Sin ninguna cubeta poblada → `NoCicAvailableError`.
  - **POOL-1.7b** — Si `noVerificables >= (ajenos + ocupadas)` → `TvPoolUnavailableError` (503, reintentable). La duda gana sólo cuando **domina o empata**: un único fallo de verificación NO puede enmascarar N venenos.
  - **POOL-1.7c** — Si no → `TvPoolPoisonedError` con `poisonedCount = ajenos + ocupadas`.
  - **POOL-1.7d** — El mensaje DEBE nombrar la causa REAL de cada descarte. Decir "identidad ajena" cuando la causa fue "cuenta ocupada" es mentirle al operador sobre qué tiene que arreglar.

  > **Historia de este requisito** — se equivocó dos veces y las dos las cazó un revisor.
  > 1. La versión original decía *"si hubo al menos un CIC clasificado `ajeno`"*. Dos tests preexistentes (F5(a)/FIX-1, con rationale escrito) pineaban la semántica correcta y **tenían razón**: el discriminador es la presencia de IDENTIDAD, no la clasificación. Se ajustó el código al test.
  > 2. La segunda versión metía lo no-verificable dentro del veneno. Se separó en el código pero **el spec no se actualizó**, así que la implementación quedó violando su propio spec. Esta versión es la que describe el código.

- **POOL-1.8** *(AÑADIDO en la RONDA 4)* — El chequeo del estado de la cuenta (PURO, sobre el dato del listado) DEBE evaluarse **ANTES** de la verificación de elegibilidad (I/O contra el mirror).

  > Es gratis y CONCLUYENTE: si la cuenta está ocupada, no hay nada que preguntarle a la DB. Tenerlo detrás del I/O falible hacía que, con un blip de Postgres, un pool donde NADA es reutilizable saliera como 503 reintentable en vez del 422 que corresponde — el mismo enmascaramiento de POOL-1.7b, sobreviviendo a nivel POR ENTRADA.

- **POOL-1.9** *(AÑADIDO en la RONDA 4)* — Un CIC de formato inválido DEBE dejar rastro en el log, con el valor ofensor.

  > Con el pool exacto del incidente el sistema decía *"no hay CIC disponible"* y no dejaba **una sola línea** con el cic corrupto. OBS-1 cubrió el 403 del partner, que era el SÍNTOMA; la causa raíz —el string con el espacio— seguía muda, que es justo lo que costó el diagnóstico la primera vez.

**Invariante de elegibilidad (las CUATRO condiciones son obligatorias):**

1. El `clientId` derivado del `internal_id` EXISTE en el mirror local.
2. Ese cliente tiene `tvCancelledAt` seteado (baja de TV local).
3. Ese cliente NO tiene ninguna fila de `ContractService` de TV activa.
4. *(AÑADIDA en el fix wave, refinada en las rondas 3 y 4)* **El PARTNER confirma que la cuenta de ese CIC está realmente libre**, usando el dato que YA viene en la entrada del listado del pool — **sin ninguna llamada extra**:
   - `email`, `firstName`, `lastName` y `registrationDate` vacíos (`null` o `''` **explícito**), y
   - `ott.registeredDevices === 0`.

   Un campo **ausente** (`undefined`) es DESCONOCIDO, no vacío: la condición no se cumple y el CIC va a `noVerificables`, no a veneno.

   > **Por qué se usa el dato del LISTADO y no un `getAccountByCic`** (RONDA 3): el GET extra era redundante —`listAccounts` y `getAccountByCic` comparten el mismo mapper, así que los campos ya venían— **y colgaba la premisa de un endpoint que nadie verificó para cuentas del pool**. Si ese GET respondiera distinto, la feature quedaba inerte con el CI verde, porque todos los fakes devuelven lo que el código espera.
   >
   > **Por qué `registeredDevices`** (RONDA 4): es una señal ORTOGONAL, en otra rama del payload. Los cuatro campos de `crm` pueden fallar juntos ante un cambio de shape; además `normalizeRegistrationDate` colapsa a `null` tanto la clave ausente como un formato desconocido, así que **para ese campo la falla-cerrada no aplica**. Una cuenta con dispositivos registrados no está libre por definición.

  > **Por qué hizo falta la 4ta.** Las tres primeras viven en el mirror local y el review demostró que el mirror puede decir "elegible" sobre un cliente con una cuenta VIVA: (a) el propio alta deja la fila de TV en `inactive` ("todavía no hay packs"), (b) `clearCancelled` es best-effort y puede dejar el flag puesto, y (c) tras una transferencia el cliente ORIGEN queda cancelado + fila inactiva mientras el CIC es del DESTINO. En los tres casos reutilizar ese CIC le roba la TV a alguien — el incidente Centeno atravesando el filtro puesto para evitarlo. La única fuente de verdad sobre si la cuenta está libre es el partner.

**Escenarios:**

> **Given** el pool tiene un CIC limpio y otro reutilizable
> **When** se solicita un alta
> **Then** el sistema DEBE elegir el **limpio**

> **Given** el pool sólo tiene CICs estampados con la identidad de clientes nuestros dados de baja
> **When** se solicita un alta
> **Then** el sistema DEBE elegir uno de ellos y completar el alta

> **Given** el pool sólo tiene un CIC estampado con la identidad de un cliente nuestro **sin** `tvCancelledAt` (caso `ALVEZ SUSANA`)
> **When** se solicita un alta
> **Then** el sistema NO DEBE elegirlo
> **And** DEBE fallar con `TvPoolPoisonedError` (422)

> **Given** el pool sólo tiene un CIC con `internal_id = "algo-que-no-es-uuid"`
> **When** se solicita un alta
> **Then** el sistema NO DEBE elegirlo (defaultea a `ajeno`)

---

## ADDED — `POOL-2`: reintento acotado ante un CIC inservible

- **POOL-2.1** *(ENDURECIDO en el fix wave)* — El sistema DEBE reintentar con otro candidato SÓLO si el `GigaredNotFoundError` del `register` viene marcado `cicNotOwned` — es decir, si nació de un **403 `cic-ownership-error`**, la única respuesta que prueba que el partner rechazó ANTES de crear nada.
- **POOL-2.1b** *(AÑADIDO)* — Un `GigaredNotFoundError` SIN esa marca DEBE producir `TvIdentityStampUnverifiedError` (503, reintentable), NUNCA un reintento con otro CIC.

  > **Por qué.** El spec original afirmaba que "un not-found en el register prueba que nada se creó". Es **falso**: `mapError` también produce `GigaredNotFoundError` desde un **424 `external-service-error`** con detail *"no se encontró"*, y un 424 significa que el partner ACEPTÓ el request y su downstream (el CUA) falló ⇒ **el estado queda desconocido**. Reintentar ahí con otro CIC puede crear una **segunda cuenta real** — el doble cobro de la lección F1, multiplicado por `MAX_CANDIDATOS`.
- **POOL-2.2** — El reintento DEBE estar acotado a un máximo de **3** candidatos por alta.
- **POOL-2.3** — El reintento SÓLO aplica a `GigaredNotFoundError` en el paso `register`. Cualquier otro error DEBE propagarse sin reintento.
- **POOL-2.4** — Agotados los candidatos, el sistema DEBE fallar con `TvNoUsableCicError` (HTTP 422), NUNCA con un `GigaredNotFoundError` crudo.

> **Rationale:** un `403 cic-ownership-error` / `404` en `register` prueba que la cuenta no es nuestra ⇒ nada se creó ⇒ el reintento es seguro. Se excluye todo otro error para no arriesgar un doble registro (lección F1: doble cobro).

**Escenario:**
> **Given** el primer candidato hace que el partner responda 403 `cic-ownership-error`
> **And** existe un segundo candidato válido
> **When** se solicita un alta
> **Then** el sistema DEBE completar el alta sobre el segundo candidato
> **And** el operador NO DEBE ver ningún error

---

## MODIFIED — `ERR-1`: ningún 404 crudo del partner durante un alta

**Antes:** cinco llamadas al partner dentro de `resolveGigaredAccount` propagaban un `GigaredNotFoundError` crudo, que el router traducía a **404 `"Gigared account not found"`** — un mensaje que al operador le lee como *"el cliente no existe"*.

- **ERR-1.1** *(ACOTADO en el fix wave)* — El listado del pool que falle con `GigaredNotFoundError` DEBE producir `TvPoolUnavailableError` (503). **Todo otro error DEBE propagarse TAL CUAL**, conservando su propio código de wire y su `detail`.

  > La versión original envolvía TODO. El review mostró que aplastaba `GigaredAuthError` (API key vencida), `GigaredNotConfiguredError` y `GigaredRejected` en un 503 *"reintentá en unos segundos"* — el operador reintentaría para siempre sobre algo que no se arregla solo — y tiraba el `detail` RFC 9457 que #47g existe para exponer.
- **ERR-1.1b** *(AÑADIDO)* — Un fallo de la verificación de elegibilidad NO DEBE abortar el alta: se trata al candidato como no elegible y el alta continúa con los CICs limpios. *(Sin esto, un blip de Postgres tiraba un 500 aunque hubiera un CIC limpio disponible.)*
- **ERR-1.2** — `register`, `activate` y `setInternalId` que fallen con not-found DEBEN producir un error tipado del dominio TV, NUNCA un `GigaredNotFoundError` crudo.
- **ERR-1.3** — Ningún camino de `RegisterGigaredAccount.execute` PUEDE terminar en un HTTP 404 cuyo mensaje sea `"Gigared account not found"`.

**Escenario (regresión del bug reportado):**
> **Given** cualquier estado del pool
> **When** se solicita un alta y el partner rechaza el CIC elegido
> **Then** la respuesta NO DEBE ser `404 GIGARED_NOT_FOUND`

---

## ADDED — `OBS-1`: observabilidad del rechazo del partner

- **OBS-1.1** — El adapter DEBE loguear todo `403 cic-ownership-error` con su `detail` antes de traducirlo a `GigaredNotFoundError`. **Es la señal que faltaba**: era el rechazo mudo del incidente.
- **OBS-1.2** ~~El adapter DEBE loguear todo `404` que NO sea `empty-accounts_list`.~~ **REVERTIDO en el fix wave.** El adapter NO DEBE loguear los 404.

  > El review demostró que el requisito original era contraproducente: el 404 es el **happy path** de `GetGigaredCustomerAccount` ("este cliente no tiene TV" — o sea CADA apertura de panel de un cliente sin TV), del probe idempotente de cada alta y del probe del destino en `TransferTvToCustomer`. Loguearlos todos sepulta bajo miles de líneas esperadas la única que importaba. **El fix de observabilidad se enterraba a sí mismo.**
- **OBS-1.3** — Un `404 empty-accounts_list` (cero filas, esperado) NO DEBE loguearse, y `listAccounts` DEBE seguir traduciéndolo a `[]`.
- **OBS-1.4** *(AÑADIDO)* — Todo status distinto de 404 DEBE loguearse (comportamiento previo, preservado).

> **Rationale:** hoy `mapError` sólo loguea `if (status !== 404)`, y la rama `cic-ownership-error` retorna **antes** de esa línea. Ni el 403 ni el 404 dejaban rastro — por eso este bug fue invisible en producción.

---

## ADDED — `AUD-1`: rastro de la reutilización de un CIC

- **AUD-1.1** — Cuando un alta se completa sobre un CIC **reutilizado**, el sistema DEBE emitir un `AuditEvent` con `action = 'tv.cic_reused'`, el `cic`, el `internal_id` previo y el `clientId` del dueño anterior.
- **AUD-1.2** — El evento de activación de TV DEBE registrar la reutilización de forma visible para el operador en el Historial de TV.
- **AUD-1.3** — El fallo del rastro NO DEBE abortar el alta ya completada (best-effort, igual que el resto de los side-effects del use case).

> **Rationale:** la forense del incidente Centeno fue arqueología pura **porque nadie había registrado el CIC**. Es la lección del breadcrumb B6.
