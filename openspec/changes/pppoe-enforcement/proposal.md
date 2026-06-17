# Proposal: PPPoE Enforcement (Fase C del épico `pppoe-service`)

## Intent

Aplicar **cortes de servicio individuales y masivos** sobre los PPPoE, ejecutando en la red MikroTik el estado que GR ya marcó (deudor → reducido, baja → bloqueado, y la **restauración** al regularizar). El masivo procesa por **batches agrupados por router, con throttle y resiliencia** (importa más que termine bien que que termine rápido), sin sobrecargar los maestros. **TODO on-demand (decisión del usuario 2026-06-17): el operador dispara cada corte manualmente (con preview/confirmación); NO hay scheduler/cron automático.** Es el objetivo original del usuario y el cierre del épico: el **puente GR → red** que hoy no existe.

## Why

- GR marca a un cliente como **deudor/baja**, pero ese estado **no llega a la red** (el FreeRADIUS legacy está idle; el corte hoy es manual). El backend ya es espejo de GR (`Client.status`); falta el ejecutor que lo propague.
- La Fase B dejó el **adapter RouterOS validado contra un router real** — `updateSecret(profile=IP-REDUCCION)` + `removeActiveSession` (kick) ya funcionan. El profile `IP-REDUCCION` **ya existe** en los routers.
- El vínculo `pppoe → nasId` (Fase A) dice exactamente a qué router pegarle por cada cliente (sin depender del accounting RADIUS). 6-7K clientes repartidos en ~9-13 routers; tandas de 100 a 2000.

## Scope

### In Scope

**Dominio:**
- Campo `enforcedState` en `PppoeService`: `'active' | 'reduced' | 'blocked'` (separado del `profile` comercial, que se conserva para poder restaurar). Migración aditiva.
- Profile de corte configurable (default `IP-REDUCCION`); bloqueo = `disabled=yes`.

**Aplicación (use cases, TDD con fakes):**
- `EnforcePppoeService` (**individual**): aplica el corte/reducción/bloqueo/restauración a UN pppoe — `updateSecret`(profile reducido o disable) en el router + `removeActiveSession` (kick para que tome efecto ya) + actualiza `enforcedState`. Idempotente (re-aplicar = no-op).
- `RunBulkEnforcement` (**masivo**): toma un criterio (p.ej. todos los `status='late'` aún `enforcedState='active'`) o una lista de pppoe; **agrupa por router** → 1 carril por maestro, N routers en paralelo (`mapWithConcurrency`); throttle entre operaciones; backoff ante error; **progreso persistido + resumible**; idempotente; best-effort por item (uno falla, sigue el resto).
- Restauración masiva análoga (los que pagaron → volver a `active`).

**Infraestructura:**
- Modelo de job `ServiceCutBatch` (o reusar el patrón `status: pending|running|done|failed` + result JSON, molde `CancelTvJobRunner`): estado del batch, progreso, resultados por item, errores. Persistido (resumible si el container reinicia).
- Runner fire-and-forget + `PgAdvisoryLock` (no dos batches a la vez).
- Rutas HTTP: `POST /api/pppoe/:id/enforce` (individual), `POST /api/pppoe/enforce/bulk` (dispara batch), `GET /api/pppoe/enforce/bulk/:jobId` (progreso). Permiso nuevo `pppoe.cut` (writes de corte) — separado de `pppoe.manage`.

### Out of Scope

- **Cambiar el estado en GR**: el backend solo EJECUTA en la red el estado que GR ya determinó; no escribe a GR (decisión del épico).
- **Decidir quién es deudor**: eso es GR. Acá solo se actúa sobre los que GR/`status` marcó (o una lista provista).
- **RADIUS CoA**: el corte va por MikroTik API (adapter de B). CoA queda futuro.
- **Cortes automáticos / scheduler**: NO — **todo on-demand** (decisión del usuario 2026-06-17). El backend NO corta solo ni en cron; el operador dispara cada batch (individual o masivo) manualmente. Un scheduler automático queda explícitamente fuera por ahora.
- **UI**: la página de cortes es trabajo FE coordinado (este change expone endpoints + DTO). Ver ítem en BACKLOG (página de cortes con skill `impeccable`).

## Capabilities

### New
- `pppoe-enforcement`: cortes individuales + masivos por batch. Spec fuente.

### Modified
- `pppoe-inventory` (Fase A): + campo `enforcedState`.
- `pppoe-management` (Fase B): reusa `PppoeRouterGateway` (`updateSecret`/`removeActiveSession`).

## Approach

1. **Modelo**: `enforcedState` en `PppoeService` (migración aditiva) + `ServiceCutBatch` para el job masivo.
2. **Use case individual** `EnforcePppoeService` (TDD con fake gateway + repo in-memory): reducción/bloqueo/restauración, idempotente, kick.
3. **Use case masivo** `RunBulkEnforcement`: agrupar por router → `mapWithConcurrency` (1-2 conexiones por router, N routers en paralelo) + throttle + backoff + progreso en `SyncState`/`ServiceCutBatch` + resumible. Reusa `mapWithConcurrency`, `PgAdvisoryLock`, throttle `sleep`, backoff (todos ya en prod).
4. **Runner + rutas + RBAC** (`pppoe.cut`).
5. **TDD**: individual (reduce/block/restore/idempotente/router caído); masivo (agrupa por router, best-effort, progreso, resumible, throttle); rutas (401/403/202/progreso).

## Affected Areas

| Área | Impacto |
|------|---------|
| `prisma/schema.prisma` + migración | `enforcedState` en PppoeService + tabla `ServiceCutBatch` |
| `src/domain/entities/pppoeService.ts` | + `enforcedState` |
| `src/application/use-cases/EnforcePppoeService.ts` + `RunBulkEnforcement.ts` | New |
| `src/infrastructure/scheduling/ServiceCutRunner.ts` | New (molde CancelTvJobRunner) |
| `src/infrastructure/http/routes/pppoe.routes.ts` | + endpoints de enforce |
| `src/application/dto/pppoe.dto.ts` | + DTOs de batch/progreso |
| RBAC + migración | permiso `pppoe.cut` |
| `app.ts` | wiring + composition test |

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| **Cortar al cliente equivocado** (masivo) | Alta | La lista sale de `status='late'` (espejo GR) o lista explícita revisable; dry-run/preview del batch (cuántos, qué routers) antes de ejecutar; log por item |
| Sobrecargar un maestro | Media | 1 carril por router + concurrencia baja + throttle configurable (resiliencia > velocidad, pedido del usuario) |
| Perder el profile comercial al reducir | Media | `profile` comercial se conserva en DB; el router cambia, la DB recuerda → restauración vuelve al original |
| Batch interrumpido (reinicio) | Media | Progreso persistido + resumible + idempotente (re-aplicar = no-op) |
| Router caído a mitad del batch | Media | Best-effort por item + por router; el item queda `failed` reintentable, no aborta el lote |
| Doble ejecución de batch | Baja | `PgAdvisoryLock` |

## Rollback

Aditivo (campo + tabla + use cases + rutas nuevas). `git revert` del merge. Los cortes ya APLICADOS en routers no se revierten con git (la restauración es una operación de negocio, no un revert de código) — documentado.

## Dependencies

- Fase A (`PppoeService`) + Fase B (`PppoeRouterGateway` validado) — hechas. El apply de C se encadena sobre B.
- `IP-REDUCCION` (o el profile de corte) existe en los routers — confirmado en Phase 0.
- `mapWithConcurrency`, `PgAdvisoryLock`, `SyncState` — ya en prod.

## Success Criteria

- [ ] `POST /api/pppoe/:id/enforce` reduce/bloquea/restaura UN pppoe (router + DB + kick), idempotente.
- [ ] `POST /api/pppoe/enforce/bulk` dispara un batch async (202) sobre `status='late'` o lista; `GET .../:jobId` muestra progreso.
- [ ] El batch agrupa por router (no satura un maestro), throttle configurable, best-effort, resumible.
- [ ] El `profile` comercial se conserva; la restauración vuelve al original.
- [ ] Router caído → item `failed`, no aborta el lote.
- [ ] 401/403 (`pppoe.cut`); `npm test` verde + tsc limpio; DIP preservado; composition test del wiring.
