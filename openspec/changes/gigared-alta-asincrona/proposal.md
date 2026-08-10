# Proposal: alta de TV asíncrona (Gigared)

## Intent

Las altas de TV **no entran desde el 2026-08-06 14:49** (última alta exitosa, `tv_activation_events`). No fue un deploy nuestro: el último cambio de código es del 08-05 y no toca TV.

La causa está **medida en vivo** contra `partners.gigaredsa.com.ar`, no inferida: el partner corta a **~10 requests por ventana de 60 s**, se recupera dentro de los 60 s, y **no manda `Retry-After` ni `X-RateLimit-*`** (verificado con `curl -D -`). 15 llamadas seguidas dieron `200×10` y después `429×5`.

El mecanismo del daño:

```
register   → OK        (la cuenta ya se creó en el partner)
activate   → 429       → "Error durante la activacion"
                ↓
        queda una ACTIVACIÓN PENDIENTE del lado de Gigared
                ↓
reintento  → "Existe mas de una activacion pendiente"  ← PARA SIEMPRE
```

**Cada intento fallido quema un cliente de forma permanente.** Confirmado con tres clientes distintos (CALABRIA `2553ecdf…`, ABELLO, ACESTE) y con patrón alternado en los logs: primer intento *"Error durante la activación"*, segundo *"Existe más de una activación pendiente"*.

## Por qué NO se arregla desde el cliente HTTP

Se intentó, en **4 rondas de review adversarial con 11 CRÍTICOs**. El enfoque está agotado por aritmética, no por falta de esfuerzo:

- Un alta hace **hasta 17 llamadas** al partner (probe + pool + `MAX_CANDIDATOS`×5, ver `RegisterGigaredAccount.ts`).
- Un throttle honesto contra 10/min da **8 req/min para TODO el proceso**: `GigaredClient` es **singleton** (`app.ts:2813`) y lo comparten el panel, el **portal del cliente** (`app.ts:3982`), las altas y los jobs.
- El `requestTimeout` de Node es **300 s** (default; nada lo pisa en `main.ts:73`).

Medido con simulador de eventos discretos sobre el cliente real:

| tráfico de fondo | duración del alta | ¿entra en 300 s? |
|---|---|---|
| 0 | 114 s | sí |
| 5/min | 264 s | margen cero |
| **6/min** | **361 s** | **NO** |
| 3 altas concurrentes | 354–369 s | **NO** |

**6 requests por minuto es un panel abierto cada diez segundos.** Y cuando el `requestTimeout` corta el socket, el handler sigue vivo, el operador ve un error y reintenta → segundo `register` → cliente quemado. El fix movía la falla de "429 del partner" a "nuestra propia cola" dejando el desenlace **idéntico**.

**17 llamadas contra 8/min no entran en un request síncrono, se acomode como se acomode.**

## Scope

### In Scope

- **Convertir el alta en un job asíncrono**, con el molde de `CancelTvJobRunner` (ya existe en el repo, mismo patrón de estado `running` + guard anti-doble-disparo).
- `POST /api/gigared/customers/:id/register` pasa a **202 Accepted** + identificador de job, en vez de bloquear hasta terminar.
- **Estado consultable** del job (pendiente / en curso / ok / error) para que el FE muestre progreso real en lugar de un spinner que muere a los 5 minutos.
- **Idempotencia y recuperación**: un job que muere a mitad NO puede provocar un segundo `register`. Es la propiedad central del change — el bug entero nace de ahí.
- **Throttle preventivo** del cliente HTTP (rescatable del worktree `gigared-429-backoff-be`, ver "Material reutilizable").

### Out of Scope

- Destrabar a los clientes **ya contaminados** (Calabria, Abello, Aceste): sus activaciones pendientes viven en Gigared y sólo el partner puede limpiarlas. Vía paliativa disponible: el `emailOverride` del change `gigared-email-custom`.
- Reducir las 17 llamadas por alta. Vale la pena, pero es un change propio y no bloquea a éste.
- Cambios en el partner (que mande `Retry-After`, que suba el límite, que un `register` sin `activate` no deje estado pendiente). Van por reporte a Gigared.

## Material reutilizable (del intento anterior, ya verificado)

Del worktree `gigared-429-backoff-be` (3 commits, **NO pushear como están**) se rescata:

- **La reserva de turno atómica** (`reservarTurno`): verificada con 12 cadenas × 20 llamadas concurrentes, 0 anomalías. El read-modify-write no necesita lock porque no hay `await` entre el `now()` y la escritura.
- **Los números medidos**: intervalo 7500 ms, y **burst = 2** (el techo real es `límite − 60000/intervalo`; con 8 salían 15 req en la primera ventana).
- **El clamp de `Retry-After` a 60 s** (el partner no lo manda, pero un WAF/CDN intermedio puede inyectarlo; sin tope dormía una hora en un singleton compartido con el portal).
- **El test de ventana deslizante desde frío**, que es el único que expresa el invariante real.

## Lo que se descarta explícitamente (para no repetirlo)

1. **Backoff largo dentro del request** → desborda el `requestTimeout`.
2. **Marca `now + ms` seguida de `sleep(ms)`** → inerte, vence junto con su propio sleep.
3. **Fail-fast por llamada** → el daño es **por alta**: rechazar la llamada #9 deja el `register` hecho igual.
4. **Re-anclaje de reloj por DISTANCIA de la marca** → borra backlog legítimo y desarma el throttle.

## Riesgos y decisiones a confirmar

- **¿El FE hace polling o va por SSE?** El hub de alertas ya usa SSE y hay `refetchInterval` maduro en 15+ hooks. Decisión de producto.
- **¿Qué ve el operador si el job falla a mitad?** Tiene que quedar claro si la cuenta se creó o no, porque de eso depende si puede reintentar sin quemar al cliente.
- **¿Cuántas réplicas del backend corren en prod?** No verificable desde este repo (sólo hay `Dockerfile`, sin compose). Con ≥2 réplicas el throttle per-proceso da 2×8 = 16/min contra un límite de 10 y el 429 vuelve. **Hay que confirmarlo antes de fijar los números.**

## Gate

TDD estricto, y **contrafáctico por mutación obligatorio** en cada test nuevo: en las 4 rondas anteriores aparecieron 3 tests que no protegían lo que decían — uno pasaba por el reloj mockeado, otro medía duración en vez del invariante, y otro **pasaba por accidente porque su reloj virtual arrancaba en `1_000_000`** y al restar una hora el tiempo se volvía negativo. Los contrafácticos se corren con valores del entorno REAL, no de juguete.
