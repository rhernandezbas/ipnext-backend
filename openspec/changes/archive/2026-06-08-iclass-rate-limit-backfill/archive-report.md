# Archive Report — iclass-rate-limit-backfill (#33)

**Archived**: 2026-06-08. Deployed to prod (BE PR #79, container boot confirmed). No migration. BE-only.

## Disparador / diagnóstico
Tras el #32 (backfill async), darle "Reconciliar" no hacía nada. Diagnóstico vía logs del VPS (`docker logs ipnext-new-backend`): `[backfill-scheduler] ERROR: IClass responded with HTTP 429`. El backfill recorre ~78 tareas in-flight secuencialmente pero **sin pausa entre llamadas top-level** → la ráfaga dispara el rate limit de IClass (HTTP 429), y **un solo 429 abortaba todo el batch** (sin try/catch por tarea). El `IClassClient` ya manejaba la otra forma de rate-limit (200 + texto "Espere um pouco") pero NO el HTTP 429 real.

## Fix
1. **`IClassClient`: retry del HTTP 429** dentro de `withAuthRetry` — `Retry-After` (segundos) primero, si no backoff exponencial sobre `subresourceBackoffMs`, acotado a `MAX_RATE_LIMIT_RETRIES=4`, luego el throw existente vía `mapError`. **Protege TODAS las llamadas a IClass**. El re-login del 401 sigue solo en `attempt===0` (no se pisan); el path 200-texto "Espere um pouco" queda intacto.
2. **`BackfillClosedServiceOrders`: aislamiento por tarea** (try/catch → contador `failed` top-level, distinto del `errored` por-SO, `continue` sin abortar) + **throttle** `throttleMs` (default 350 ms, 0 en tests) entre tareas. Mantiene el modelo 1x1 async del #32.
3. El `failed` fluye al endpoint de status (`GET /closure/status`) + el log del scheduler.

## Ciclo SDD
explore (en vivo: logs de prod + lectura de código) → propose → spec ∥ design → tasks (26) → apply (26/26) → verify PASS 11/11 → archive. Suite 2523/0, tsc limpio.

## Nota de calidad
El verify marcó un WARNING (aserción de conteo de sleeps floja, aceptaba 2-3). El orquestador la **fijó a 3 exactos** antes de deployar (el sleep es incondicional dentro del loop, después de cada tarea → N tareas = N sleeps). Sin deuda.

## Archivos
BE: `IClassClient.ts`, `BackfillClosedServiceOrders.ts`, `IngestClosedServiceOrders.ts` (counts +`failed`), `BackfillScheduler.ts` (log), `iclassClosure.dto.ts` (`ClosureRunCounts` +`failed`), `GetClosureStatus.ts` (+`failed`) + 5 test files.

## Efecto en prod
"Reconciliar" ahora drena de verdad: una… respira (throttle)… la otra, reintentando los 429 con backoff en vez de morirse en el primero.
