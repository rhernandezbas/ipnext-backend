# Tasks: alta de TV asíncrona (Gigared)

TDD estricto: el test va primero y se **observa el rojo**. Cada test nuevo lleva su **contrafáctico por mutación** (romper el código a propósito y verificar que el test cae), corrido con valores del entorno real.

## W1 — Estado del job (fundación)

- [ ] 1.1 Migración aditiva: `tvRegisterStatus` / `tvRegisterStartedAt` / `tvRegisterResult` en `Client` (molde de los `tvCancel*` existentes). Nullable, sin default destructivo.
- [ ] 1.2 Port + adapter Prisma + in-memory para leer/escribir el estado del job.
- [ ] 1.3 **Watchdog de `running` huérfano**: un job cuyo `startedAt` supera el TTL se libera. **Test: un `running` viejo no bloquea al cliente** (es el agujero que `CancelTvJobRunner` tiene hoy y que este change NO hereda).

## W2 — Ruta asíncrona

- [ ] 2.1 `POST /customers/:id/register` responde **202 + `{ jobId }`**. **Test: el request responde sin haber llamado a Gigared ni una vez** (el fake del port no registra llamadas).
- [ ] 2.2 Se preservan TODAS las validaciones actuales antes del 202: `contractId` obligatorio, ownership del contrato, `emailOverride` bien formado. Un input inválido sigue siendo **400**, no un job que falla después.
- [ ] 2.3 Guard anti-doble-disparo: un alta ya `running` para ese cliente devuelve **409**, no encola una segunda.
- [ ] 2.4 `GET .../register/status` → `{ estado, mensaje }`, con el mismo permiso que el alta.

## W3 — Runner

- [ ] 3.1 `RegisterTvJobRunner` con el molde de `CancelTvJobRunner`. **La lógica de `RegisterGigaredAccount` NO se toca**: el runner la invoca tal cual.
- [ ] 3.2 Transiciones `pending → running → done|failed`, con el mensaje de error persistido para el polling.
- [ ] 3.3 **Test central del change**: un job que falla DESPUÉS del `register` aceptado, al reintentarse **no** produce un segundo `register` — el probe idempotente reanuda desde `activate`. Contrafáctico: romper el probe y verificar que el test cae.
- [ ] 3.4 **Test**: el `seq` no avanza si el job falla, así el reintento recomputa la MISMA identidad y el probe puede converger. Si avanzara, el reintento mintearía una identidad nueva → segundo `register` real.

## W4 — Throttle (rescate del worktree `gigared-429-backoff-be`)

- [ ] 4.1 Portar `reservarTurno()` (reserva atómica, ya verificada con 12 cadenas × 20 llamadas concurrentes).
- [ ] 4.2 `RATE_LIMIT_INTERVAL_MS = 7500`, **`RATE_LIMIT_BURST = 2`**. **Test: ninguna ventana de 60 s supera el límite, medido DESDE FRÍO.** Contrafáctico: con burst 3 el test debe caer (burst 3 da exactamente 10 = margen cero contra el número donde el partner ya cortó).
- [ ] 4.3 Clamp de `Retry-After` a 60 s + su test.
- [ ] 4.4 **NO portar el fail-fast por saturación**: su razón de ser era proteger el `requestTimeout`, que acá desaparece, y su peor efecto es rechazar la llamada #9 después de un `register` aceptado.

## W5 — FE (polling)

- [ ] 5.1 El alta dispara el POST y arranca el polling del estado (patrón `refetchInterval`, ya maduro en 15+ hooks).
- [ ] 5.2 Estados visibles: en curso / listo / **error con su mensaje** (decisión del usuario: el error y ya, sin UX de recuperación).
- [ ] 5.3 El formulario manda **`emailOverride`** cuando el operador edita el campo de email. **Hoy manda `email`, que el backend descarta** — sin esto el campo sigue sin hacer nada. Depende del change `gigared-email-custom`.
- [ ] 5.4 Doble-confirmación con impacto explícito, 4 ramas de estado y accesibilidad, según las reglas de diseño front del workflow.

## W6 — Cierre

- [ ] 6.1 Gate: suite completa + `tsc` (BE) / `typecheck` (FE), corridos por el orquestador.
- [ ] 6.2 **Review adversarial** con focos separados (idempotencia · concurrencia · tests tautológicos). No se saltea.
- [ ] 6.3 Verificación **EN VIVO** contra prod: un alta real entra, y el polling refleja el estado. Los tests mockean el HTTP y no ven un mismatch de envelope.
- [ ] 6.4 Card del BACKLOG actualizada + `sdd-archive`.

## Premisas anotadas (revisar si cambian)

- **Una sola réplica del backend** (confirmado por el usuario). Con 2+, el throttle per-proceso da 2×8 = 16/min contra un límite de 10 y el 429 vuelve: habría que coordinar entre instancias.
- El límite del partner (~10 req / 60 s) se midió **una vez**, el 2026-08-10. Conviene re-medirlo antes de fijar números definitivos.

## Fuera de alcance

- Destrabar a los clientes **ya contaminados** (Calabria, Abello, Aceste): sus activaciones pendientes viven en Gigared. Paliativo: `emailOverride`.
- Reducir las 17 llamadas por alta (change propio).
- Que el partner mande `Retry-After`, suba el límite, o no deje estado pendiente cuando el `activate` falla → reporte a Gigared.
