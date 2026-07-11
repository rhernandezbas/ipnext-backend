# Proposal — gr-client-retry-backoff

## Intent

Blindar el mirror de Gestión Real (GR) contra el **flapeo de nodos del balanceador de GR**. Hoy un
solo HTTP 503 transitorio de GR tumba toda la corrida de sync → el badge "Error de sincronización"
se pone rojo en la page Clientes hasta el próximo tick sano.

## Disparador (diagnóstico verificado en prod, 2026-07-11 03:45 AR)

- Badge rojo = `SyncState(entity='gr-clients').lastResult = "error: Request failed with status code 503"`,
  flag `gestion-real-sync` = ON. NO es bug nuestro.
- `api.gestionreal.com.ar` devuelve **503 intermitente** desde su balanceador Apache/PHP
  (`x-node: Nodo .29`, `set-cookie: MYSESSION=balancer.nodo29`). curl directo: 503 en un request,
  401 (auth challenge normal) en el siguiente → algunos nodos caídos, otros vivos.
- Afecta TODO lo GR (gr-clients / gr-ingest / gr-debtor-balances, 503 en logs). RADIUS/UISP/IClass OK.
- Es self-healing (próximo tick de 3min con GR sano escribe `lastResult='ok'`) y sin data corruption
  (el cursor se preserva en el catch de `SyncGestionRealClients`).
- NO es el bug del password-TZ (ese da error 90; ya fixeado con `isoDate()`).

## Causa del gap

`GestionRealClient` (`src/infrastructure/adapters/gestion-real/GestionRealClient.ts:46`) crea el axios
con `timeout: 30000` pero **SIN retry**. Como el LB de GR flapea, un solo 503 en cualquiera de las
~450 requests paginadas de un tick tira la corrida entera.

## What

Wrapper de reintentos en el propio `GestionRealClient` — **una sola pieza que heredan las 5 llamadas**
(`fetchClients`, `fetchContractsByClient`, `fetchClientBalance`, `fetchContractsModifiedSince`,
`getServiceOrders`). Todas son `POST` de LECTURA con `action=...` → idempotentes → reintentar es seguro.

Política (perfil **Estándar**, decisión del usuario 2026-07-11):
- **3 reintentos** (4 intentos totales).
- Backoff exponencial **300ms → 900ms → 2700ms** (base 300, factor ×3) **+ jitter** acotado.
- Respeta el header **`Retry-After`** en 429 (usa el mayor entre Retry-After y el backoff calculado).
- **Se reintenta:** 5xx (500/502/503/504) + errores de red (ECONNRESET/ECONNABORTED/ETIMEDOUT) + timeout + 429.
- **NUNCA se reintenta:** 4xx de auth (401/403) ni 400 — no se curan reintentando (password malo / payload malo).
- `auth` (password diario MD5) **recomputado fresco por intento** (por si un retry cruza medianoche AR).
- GR sano → **0ms overhead** (solo dispara ante error). Outage total → corta rápido en el request #1.

## Decisions

- **BE-only.** El badge FE ya reacciona al `lastResult`; no se toca FE. Existe re-sync manual
  (`POST /resync-all`, `gestionReal:write`) para verdear el badge cuando GR levante sin esperar el tick.
- **Sin config nueva de env obligatoria.** Los parámetros (maxRetries, base, sleep, random) son opts
  del constructor con defaults; el wiring de prod usa los defaults del perfil Estándar.
- **La superficie de error se PRESERVA**: agotados los reintentos, se re-lanza el mismo `AxiosError`
  → `SyncGestionRealClients` sigue grabando `error: ...` y el badge sigue siendo honesto ante un
  outage real. El fix solo absorbe los blips transitorios.

## Out of scope

- Circuit breaker / rate-limit global de GR (over-engineering para este caso).
- Cambios en la cadencia del scheduler o en el flujo de cursores.
- Retry para IClass/UISP/Splynx/orchestrator (otros adapters; si se quiere, follow-up separado).
- Cualquier cambio de FE.
