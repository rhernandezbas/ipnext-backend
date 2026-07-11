# Design — gr-client-retry-backoff

## Dónde

Todo vive en `src/infrastructure/adapters/gestion-real/GestionRealClient.ts`. Cero cambios de dominio,
application, ports, DTO, schema, rutas o FE. Es un endurecimiento interno del adapter.

## Seam: `private postWithRetry(payload)`

Las 5 llamadas hoy hacen `this.http.post('', payload, { auth: this.auth() })`. Se extrae un único
método privado que envuelve ESA llamada con la lógica de retry, y las 5 pasan a usarlo:

```ts
const { data } = await this.postWithRetry(payload);   // payload SOLO; el wrapper pone auth
return parseXxx(data);                                 // parse FUERA del retry (no se reintenta un parse-bug)
```

`postWithRetry` recomputa `this.auth()` DENTRO del loop, por intento (AUTH-1).

## Predicado de retry — `isRetryableAxiosError(err)`

Solo se reintentan errores de axios; cualquier otro throw (p.ej. un TypeError de un parser) se propaga
tal cual (no se reintenta un bug de código):

```
if (!err?.isAxiosError) return false            // no-axios → NO retry
status = err.response?.status
if (status === undefined) return true           // sin response = network/timeout (ECONNRESET/ABORTED/…) → retry
return status === 429 || (status >= 500 && status < 600)   // 5xx o 429 → retry; 4xx (400/401/403) → NO
```

- NO depende de `axios.isAxiosError()` (difícil bajo `jest.mock('axios')`): chequea `err.isAxiosError`
  presente en el objeto error (los AxiosError reales lo traen; los tests lo setean en el reject).
- axios por default rechaza los >=400, así que un 503 llega como AxiosError con `response.status=503`.

## Backoff

```
delayFor(i) = retryBaseMs * 3^i + jitter        // i = índice de reintento 0-based
jitter      = floor(random() * retryBaseMs)     // [0, base) — acotado, nunca negativo
```

Con `retryBaseMs=300`, `random()=0`: 300, 900, 2700. En 429 con `Retry-After: N` (segundos):
`delay = max(delayFor(i), N*1000)`.

## Parámetros (opts del constructor, con defaults del perfil Estándar)

Se agregan a `GestionRealClientOptions` (todos opcionales; el wiring de prod no cambia):

| opt | default | para qué |
|-----|---------|----------|
| `maxRetries` | `3` | reintentos tras el intento inicial (⇒ 4 intentos) |
| `retryBaseMs` | `300` | base del backoff exponencial |
| `maxBackoffMs` | `30000` | techo de CADA espera; acota un Retry-After hostil (no congela el lock) |
| `sleep` | `(ms) => new Promise(r => setTimeout(r, ms))` | inyectable; los tests pasan un spy no-op |
| `random` | `Math.random` | inyectable; los tests pasan `() => 0` o `() => ~1` |

`now` ya existe (clock inyectable del password). `Math.random`/`setTimeout` en runtime del adapter son
legítimos (la restricción de random/Date es solo para scripts de Workflow, no para el código de la app).

## Superficie de error PRESERVADA

Agotados los reintentos, `postWithRetry` re-lanza el ÚLTIMO error (mismo AxiosError). Así
`SyncGestionRealClients.ts:139-148` sigue grabando `lastResult: "error: ..."` y el badge sigue siendo
honesto ante un outage REAL. El fix solo absorbe blips transitorios; no oculta caídas reales.

## Idempotencia / seguridad de reintento

Las 5 llamadas son `POST` con `action` de LECTURA (`clientes_consulta`, `contrato`, `cliente`,
`contratos`, `ordenesdeservicio`) — no mutan nada en GR. Reintentar es seguro. GR es read-only para
Prominense (no hay POST de escritura a GR en el cliente).

## Testing (TDD, red→green)

- `jest.mock('axios')`: `axios.create` devuelve `{ post: postMock }` controlado por test.
  `new GestionRealClient({ baseUrl, cuit, secret, sleep: sleepSpy, random: () => 0, now })`.
- Secuencias con `postMock.mockRejectedValueOnce({ isAxiosError:true, response:{status:503,headers:{}} })`
  seguidas de `mockResolvedValueOnce({ data: CLIENTS_RESPONSE })`.
- Asserts: `postMock` call count, `sleepSpy` call count + args (delays), y que devuelve el parseado
  o re-lanza. Los tests NO esperan tiempo real (sleep es un spy que resuelve ya).
- Un test de herencia sobre un 2do método (`getServiceOrders`) para pinear INHERIT-1.

## Riesgos y mitigaciones (para el review adversarial)

- **Retriar un no-transitorio** → el predicado exige `isAxiosError` + status en la lista EXACTA
  (`{429,500,502,503,504}`, NO todo 5xx); un 401 (password malo, p.ej. bug TZ) o un 501/505/511
  permanente NO se reintentan (fail-fast, visible).
- **Retry-After hostil congela el lock (hallazgo review — FIXEADO)** → un 429 con `Retry-After: 3600`
  hacía que `sleep` bloqueara 1h DENTRO de `postWithRetry`, reteniendo el lock `gr-sync` (que envuelve
  todo el `runOnce`) → sync congelada en TODAS las réplicas. Mitigado: `backoffMs` clampea a
  `maxBackoffMs` (30s) y guardea un `random` no-finito. Todo backoff está acotado a ≤30s.
- **Timeout lento × 4 intentos (riesgo ACEPTADO)** → si GR timeoutea (no errorea), cada intento quema
  los 30s de `timeout` axios → hasta ~124s por request, × páginas, con el lock tomado. No hay deadline
  global. Aceptado: un hard-down corta en la página 1 (el throw aborta el run); el lock se libera al
  fin del tick y la próxima corrida (3min) skippea si sigue tomado. Follow-up posible: deadline total
  / `AbortController` compartido si se observa en prod.
- **Tick eterno si GR down duro** → un outage total falla en el request #1 (la 1ra página) y el throw
  corta la corrida entera; el retry no multiplica ×450.
- **Thundering herd entre las 2 réplicas HA** → el jitter desincroniza; además el lock distribuido
  `gr-sync` ya serializa las corridas entre réplicas.
- **Parse-bug enmascarado** → el parse queda FUERA del loop; un throw de parser se propaga sin retry.
- **Retry-After como fecha HTTP** → solo se honra el formato delta-seconds (lo que GR manda); una fecha
  HTTP cae al backoff exponencial (acotado). Supuesto aceptado.
