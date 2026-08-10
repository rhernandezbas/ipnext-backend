# Design: alta de TV asíncrona (Gigared)

## Decisiones del usuario (2026-08-10)

| # | Decisión | Consecuencia de diseño |
|---|---|---|
| 1 | **Una sola réplica** del backend en prod | El throttle **per-proceso es válido**: 8 req/min es el caudal real contra el partner. Sin coordinación entre instancias. **Queda como premisa anotada**: el día que se escale a 2+ réplicas, 2×8 = 16/min contra un límite de 10 y el 429 vuelve. |
| 2 | **Polling** (no SSE) | El FE consulta el estado del job. Reusa el patrón `refetchInterval` ya maduro en 15+ hooks; no hace falta tocar el bus de eventos. |
| 3 | **El operador ve el error y ya** | Sin UX de recuperación… **pero eso obliga a que el reintento sea SEGURO** (ver abajo). Es la restricción más fuerte del change. |

## La propiedad central: reintentar no puede quemar al cliente

La decisión 3 dice que el operador sólo ve "falló". Entonces va a **reintentar** — es lo que hizo con Calabria, Abello y Aceste. Y hoy ese reintento es exactamente lo que deja la segunda activación pendiente.

⇒ **El reintento tiene que ser idempotente por construcción, no por disciplina del operador.**

La pieza ya existe: `RegisterGigaredAccount.resolveGigaredAccount` hace un **probe** por `internalId` antes de registrar (`B2 (D2) — recovery/probe idempotente`). Si el `register` anterior llegó a crear la cuenta, el probe la encuentra y el flujo **reanuda** en vez de volver a registrar.

Lo que hay que garantizar en este change:

1. El job **no persiste el avance del `seq`** si falla (ya es así: `RegisterGigaredAccount.ts:797` lo persiste recién tras verificar). Eso hace que el reintento recompute **la misma identidad** y el probe pueda converger. Si el seq avanzara, el reintento mintearía una identidad nueva y el probe fallaría → segundo `register` real.
2. Un job que muere a mitad (proceso caído, deploy) **no puede dejar el estado en `running` para siempre**. `CancelTvJobRunner` tiene hoy ese agujero: no hay watchdog que expire un `running` viejo, y un reinicio en el momento equivocado deja al cliente sin poder volver a operar sin tocar la DB a mano. **Este change NO lo hereda**: el estado lleva timestamp y se expira.
3. **Un `register` aceptado cuyo `activate` falla NO puede reintentarse a ciegas.** El probe es el que lo distingue: si la cuenta ya existe con MI `internalId`, se reanuda desde `activate`, nunca desde `register`.

## Flujo

```
POST /api/gigared/customers/:id/register
  → valida (contractId, ownership, emailOverride)
  → crea el job (estado `pending`) y responde 202 { jobId }
  → NO toca Gigared en el request

runner (background)
  → toma el job → `running` (con timestamp)
  → corre el flujo actual de RegisterGigaredAccount, sin cambios de lógica
  → el throttle del cliente HTTP se toma sus ~114 s sin que nadie lo corte
  → `done` | `failed` (+ mensaje)

GET .../register/status  (polling del FE)
  → { estado, mensaje }
```

El `requestTimeout` de 300 s deja de importar: **el request ya no espera al partner**.

## Estado del job

Molde `CancelTvJobRunner` (mismo patrón que `tvCancelStatus` / `tvCancelStartedAt` / `tvCancelResult` en `Client`), con **la corrección del watchdog**: un `running` cuyo `startedAt` supera un TTL se considera muerto y se libera. Sin eso, un deploy en el momento equivocado bloquea al cliente para siempre — el riesgo ya está anotado en el review de `CancelTvJobRunner`.

## Throttle: qué se rescata del intento fallido

Del worktree `gigared-429-backoff-be` (3 commits, **no pushear como están**):

- `reservarTurno()` — reserva atómica, verificada con 12 cadenas × 20 llamadas concurrentes.
- `RATE_LIMIT_INTERVAL_MS = 7500` y **`RATE_LIMIT_BURST = 2`** (el techo real es `límite − 60000/intervalo`; con 8 salían **15 req** en la primera ventana contra un límite de 10).
- Clamp de `Retry-After` a 60 s.
- El test de **ventana deslizante desde frío**, único que expresa el invariante real.

**Se descarta el fail-fast por saturación.** Su razón de ser era proteger el `requestTimeout`; con el alta asíncrona ese techo desaparece y el fail-fast sólo aporta su peor efecto: rechazar la llamada #9 **después** de un `register` aceptado. Si más adelante hiciera falta un límite de cola, va **por job encolado**, nunca por llamada.

## Lo que NO se hace (y por qué)

- **Backoff largo dentro del request** → desborda el timeout. Probado, falló.
- **Marca `now + ms` + `sleep(ms)`** → inerte: vence junto con su propio sleep. Probado, falló.
- **Fail-fast por llamada** → el daño es por alta. Probado, falló dos veces (45 s y 120 s).
- **Re-anclaje de reloj por distancia de la marca** → borra backlog legítimo y desarma el throttle. Probado, falló.

## Gate

TDD estricto + **contrafáctico por mutación en cada test nuevo**, corrido con valores del entorno REAL. En las 4 rondas previas aparecieron 3 tests que no protegían lo que decían; el peor **pasaba por accidente porque su reloj virtual arrancaba en `1_000_000`** y al restarle una hora el tiempo se volvía negativo, cumpliendo la condición sola. Con `Date.now()` real eso nunca ocurre.

Tests que este change necesita sí o sí:

1. Un job que falla **después** del `register` y se reintenta → **no** hay segundo `register` (el probe reanuda).
2. Un job `running` cuyo proceso murió → se expira y el cliente puede volver a operar.
3. El request responde **202 sin haber tocado Gigared**.
4. Ninguna ventana de 60 s supera el límite del partner, medido **desde frío**.
