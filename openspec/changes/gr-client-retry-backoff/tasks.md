# Tasks — gr-client-retry-backoff

TDD estricto: para cada bloque, test ROJO primero, después el código, después verde.

## 1. Andamiaje de test (mock de axios)
- [ ] 1.1 Nuevo archivo `src/__tests__/infrastructure/adapters/gestion-real/GestionRealClient.retry.test.ts`
      con `jest.mock('axios')`: `axios.create` → `{ post: postMock }`. Helper `axiosErr(status?, {code, headers})`.
- [ ] 1.2 Factory de cliente bajo test: `new GestionRealClient({ baseUrl, cuit, secret, now, sleep: sleepSpy, random })`.

## 2. Opts + defaults (RETRY-6, sin retry visible aún)
- [ ] 2.1 (rojo) test happy-path: 200 de una → 1 call a `post`, 0 a `sleep`.
- [ ] 2.2 Extender `GestionRealClientOptions` con `maxRetries?/retryBaseMs?/sleep?/random?` + defaults del perfil.
- [ ] 2.3 Introducir `private async postWithRetry(payload)` que hoy hace 1 intento (auth fresco) → verde 2.1.
- [ ] 2.4 Reapuntar las 6 llamadas (`fetchClients`, `fetchContractsByClient`, `fetchClientBalance`,
      `fetchContractsModifiedSince`, `getServiceOrders`) a `postWithRetry(payload)`. Suite sigue verde.

## 3. Predicado + loop de retry (RETRY-1/2/4/5)
- [ ] 3.1 (rojo) 503-luego-200 → 2 calls, devuelve parseado (RETRY-1).
- [ ] 3.2 (rojo) ECONNABORTED-luego-200 → 2 calls (RETRY-2).
- [ ] 3.3 (rojo) 401 → 1 call, 0 sleep, re-lanza (RETRY-4).
- [ ] 3.4 (rojo) 400 → 1 call, re-lanza (RETRY-4).
- [ ] 3.5 (rojo) 503 ×4 → 4 calls, 3 sleeps, re-lanza el AxiosError (RETRY-5).
- [ ] 3.6 Implementar `isRetryableAxiosError` + el loop (intentos hasta `maxRetries+1`, sleep entre) → verde 3.x.

## 4. Backoff + jitter (BACKOFF-1)
- [ ] 4.1 (rojo) `random=()=>0`, 503×4 → `sleep` llamado con 300, 900, 2700 en orden.
- [ ] 4.2 (rojo) jitter acotado: `random=()=>~1` → delay del intento 0 en `[300,600)`, nunca negativo.
- [ ] 4.3 Implementar `delayFor(i)` exponencial + jitter → verde 4.x.

## 5. Retry-After en 429 (RETRY-3)
- [ ] 5.1 (rojo) 429 con `retry-after: 2` luego 200 → `sleep` con ≥2000ms antes del reintento.
- [ ] 5.2 Implementar `max(delayFor(i), retryAfterMs)` leyendo el header → verde 5.1.

## 6. Herencia + auth (INHERIT-1, AUTH-1)
- [ ] 6.1 (rojo) `getServiceOrders` 503-luego-200 → 2 calls, parseado (INHERIT-1).
- [ ] 6.2 (rojo) AUTH-1: 503-luego-200 → cada request lleva su `auth` (password recomputado por intento).

## 7. Gate + review (los corre el ORQUESTADOR, no el agente)
- [ ] 7.1 Suite completa Jest verde (número exacto reportado por el orquestador, no por el sub-agente).
- [ ] 7.2 `tsc --noEmit` limpio.
- [ ] 7.3 Chequeo DIP: cero imports nuevos de infra en dominio/application (no debería haber ninguno; es adapter puro).
- [ ] 7.4 Review adversarial (mín. 1 foco: ¿reintenta algo no-idempotente/no-transitorio? ¿enmascara un outage real?
      ¿el jitter puede dar negativo o desbordar? ¿algún método quedó sin reapuntar a `postWithRetry`?).
- [ ] 7.5 Fix wave TDD de los hallazgos + re-review focalizada hasta CLEAN.

## 8. Cierre
- [ ] 8.1 `sdd-verify`: matriz de spec-compliance (cada scenario ↔ test verde).
- [ ] 8.2 Commit conventional (sin atribución IA) en `fix/gr-client-retry-backoff`.
- [ ] 8.3 Push confirmado por el usuario (gate) → seguir el run en `gh` hasta verde (incl. step de migraciones = no-op).
- [ ] 8.4 Actualizar la card del BACKLOG a ✅ HECHO Y EN PROD + sync de `main` local (ambos: BE) con `origin/main`.
- [ ] 8.5 `sdd-archive`.
