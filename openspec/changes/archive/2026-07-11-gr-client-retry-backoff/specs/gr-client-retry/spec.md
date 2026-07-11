# Spec — gr-client-retry (delta)

Formato RFC-2119. Cada scenario DEBE quedar cubierto por al menos un test verde (sdd-verify).
Capability: resiliencia de red del `GestionRealClient` (retry-on-transient + backoff).

## Capability: reintentos ante errores transitorios

### Requirement: RETRY-1 — reintenta y se recupera ante 5xx transitorio
El cliente MUST reintentar una request que falla con status 500/502/503/504 y, si un reintento
tiene éxito, devolver el resultado parseado normalmente (el error transitorio queda absorbido).

#### Scenario: 503 y luego éxito
- Given `fetchClients` cuya 1ra llamada HTTP responde 503 y la 2da responde 200 con clientes
- When se ejecuta `fetchClients`
- Then el cliente hace 2 llamadas HTTP, devuelve el resultado parseado de la 2da, y NO propaga error

### Requirement: RETRY-2 — reintenta ante error de red / timeout
El cliente MUST reintentar cuando el error no trae response HTTP (network) o es un timeout de axios
(`ECONNRESET`/`ECONNABORTED`/`ETIMEDOUT` o `err.response` ausente).

#### Scenario: ECONNABORTED y luego éxito
- Given una llamada que primero rechaza con un AxiosError sin `response` (code `ECONNABORTED`) y luego 200
- When se ejecuta el método
- Then reintenta y devuelve el resultado; 2 llamadas HTTP

### Requirement: RETRY-3 — reintenta ante 429 respetando Retry-After
El cliente MUST reintentar ante 429 y, si viene el header `Retry-After` (segundos), esperar al menos
ese tiempo antes del reintento (usa el mayor entre Retry-After y el backoff calculado).

#### Scenario: 429 con Retry-After=2 y luego éxito
- Given una llamada que responde 429 con `retry-after: 2` y luego 200
- When se ejecuta el método (con `sleep` inyectado espía)
- Then `sleep` se invoca con al menos 2000ms antes del reintento, y la 2da llamada devuelve el resultado

### Requirement: RETRY-4 — NO reintenta 4xx de auth ni 400
El cliente MUST NOT reintentar ante 400/401/403: re-lanza inmediatamente, en el 1er intento.

#### Scenario: 401 no se reintenta
- Given una llamada que responde 401
- When se ejecuta el método
- Then hace EXACTAMENTE 1 llamada HTTP, NO llama a `sleep`, y re-lanza el AxiosError

#### Scenario: 400 no se reintenta
- Given una llamada que responde 400
- When se ejecuta el método
- Then 1 sola llamada HTTP y re-lanza

### Requirement: RETRY-5 — reintentos agotados re-lanzan el último error
El cliente, tras agotar los reintentos (4 intentos con el default), MUST re-lanzar el último error
(mismo AxiosError) para que la capa superior grabe `error: ...` en `SyncState` (badge honesto).

#### Scenario: 503 persistente
- Given una llamada que responde 503 en los 4 intentos
- When se ejecuta el método (sleep inyectado no-op)
- Then hace 4 llamadas HTTP, llama `sleep` 3 veces, y re-lanza el AxiosError 503

### Requirement: RETRY-6 — éxito al primer intento no penaliza
El cliente, si la 1ra llamada tiene éxito, MUST NOT llamar a `sleep` ni reintentar.

#### Scenario: happy path
- Given una llamada que responde 200 de una
- When se ejecuta el método
- Then 1 llamada HTTP, 0 llamadas a `sleep`

## Capability: backoff y herencia

### Requirement: BACKOFF-1 — schedule exponencial con jitter acotado
El delay del reintento `i` (0-based) MUST ser `retryBaseMs * 3^i` más un jitter en `[0, retryBaseMs)`.
Con `retryBaseMs=300` y jitter cero: 300, 900, 2700. El jitter MUST estar acotado (no negativo, < base).

#### Scenario: delays sin jitter
- Given `random` inyectado que devuelve 0 y 503 persistente
- When se ejecuta el método
- Then `sleep` se llama con 300, 900, 2700 en ese orden

#### Scenario: jitter acotado
- Given `random` inyectado que devuelve ~1 (máximo)
- When se calcula el delay del intento 0
- Then el delay queda en `[300, 600)` (base + jitter < 2×base), nunca negativo

### Requirement: INHERIT-1 — todas las llamadas heredan el retry
El retry MUST aplicar a las 6 llamadas del cliente, no solo a `fetchClients`.

#### Scenario: getServiceOrders también reintenta
- Given `getServiceOrders` cuya 1ra llamada responde 503 y la 2da 200
- When se ejecuta
- Then reintenta y devuelve el resultado parseado (2 llamadas HTTP)

### Requirement: AUTH-1 — auth fresco por intento
El cliente MUST recomputar el `auth` (password diario) en cada intento (no reusar el del 1er intento).

#### Scenario: dos intentos, dos auth computados
- Given un `now` inyectado y 503-luego-200
- When se ejecuta el método
- Then el password MD5 se computa por cada intento (verificable: 2 requests, cada una con su auth)
