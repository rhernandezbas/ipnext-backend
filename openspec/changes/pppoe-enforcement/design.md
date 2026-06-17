# Design: PPPoE Enforcement (Fase C)

## Contexto

Cortes **on-demand** (individuales + masivos por batch) que ejecutan en la red el estado de GR, reusando el `PppoeRouterGateway` de la Fase B (ya validado contra un router real). Nada automático: el operador dispara cada acción.

## Decisión 1 — Modelo: `enforcedState` separado del `profile` comercial ⭐

Campo nuevo en `PppoeService` (migración aditiva): `enforcedState: 'active' | 'reduced' | 'blocked'` (default `'active'`).

| Acción | En el router | En la DB | Kick |
|--------|--------------|----------|------|
| `reduce` (deudor) | `updateSecret(profile = IP-REDUCCION)` | `enforcedState='reduced'` (el `profile` comercial **se conserva**) | sí |
| `block` (baja) | `updateSecret(disabled=yes)` | `enforcedState='blocked'` | sí |
| `restore` (pagó) | `updateSecret(profile = <profile comercial de la DB>, disabled=no)` | `enforcedState='active'` | sí |

**Clave**: el `profile` comercial NUNCA se pierde — el router cambia a `IP-REDUCCION`, pero la DB recuerda el original, así `restore` lo devuelve. El `kick` (`removeActiveSession`) tras cada cambio fuerza que tome efecto ya (si no, recién aplicaría en la próxima reconexión).

## Decisión 2 — Use case individual `EnforcePppoeService`

`execute({ id, action })` → `findById` + `findNasServerById` → aplica en router (updateSecret + kick) → actualiza `enforcedState`. **Idempotente**: aplicar `reduce` a uno ya `reduced` = no-op seguro (re-aplica el mismo profile). Router caído → `RouterUnreachableError` (502), la DB no miente.

## Decisión 3 — Use case masivo `RunBulkEnforcement` (on-demand, NO scheduler)

`execute({ action, target })` donde `target` = `'debtors'` (todos los `Client.status='late'` con sus pppoe `enforcedState='active'`) **o** `{ pppoeIds: [...] }` (lista explícita).

1. Resolver la lista de pppoe.
2. **Agrupar por `nasId`** → cada router es un "carril": `mapWithConcurrency` con **1-2 ops por router** y **N routers en paralelo** (no satura un maestro).
3. **Throttle** configurable (`sleep`) entre ops del mismo router.
4. Por pppoe → `EnforcePppoeService` (reusa el individual). **Best-effort**: try/catch por item → `failed`, NO aborta el lote. **Backoff** ante `RouterUnreachableError`.
5. **Progreso persistido** en `ServiceCutBatch` (resumible si el container reinicia; retoma los `pending`).
6. **`PgAdvisoryLock`** → no dos batches a la vez.
7. **Fire-and-forget** disparado por `POST` (on-demand). **NO hay scheduler/cron** (decisión del usuario).

Toda la plomería (`mapWithConcurrency`, `PgAdvisoryLock`, throttle `sleep`, backoff, molde `CancelTvJobRunner`) ya está en prod.

## Decisión 4 — Preview obligatorio antes del masivo (seguridad)

`POST /api/pppoe/enforce/preview { action, target }` → `{ total, byRouter: {nasId: count}, sample: [...] }` **SIN ejecutar nada**. El operador ve el impacto (cortar 2000 clientes es serio) y recién entonces dispara el `bulk`. El `jobId` del bulk es independiente del preview.

## Decisión 5 — Modelo `ServiceCutBatch` (estado del job)

Tabla nueva (migración aditiva): `id`, `action`, `status` (`pending|running|done|failed`), `total`, `doneCount`, `failedCount`, `result` (JSON por-item: `{pppoeId, ok, error?}`), `createdAt`, `finishedAt`. Permite progreso poleable + resumible + auditoría. (Alternativa evaluada: reusar el patrón de columnas tipo `CancelTvStatus` — se opta por tabla propia porque el batch agrupa N items con resultado por-item.)

## Decisión 6 — Profile de corte configurable

Default `IP-REDUCCION` (existe en los routers, confirmado Phase 0). Configurable vía `config` (`ROUTER_REDUCED_PROFILE`) por si cambia el nombre. Bloqueo = `disabled=yes` (no necesita profile).

## Decisión 7 — Wire contract BE↔FE (endpoints on-demand)

```
POST /api/pppoe/:id/enforce        body {action:'reduce'|'block'|'restore'}     → 200 PppoeServiceDto (con enforcedState)
POST /api/pppoe/enforce/preview    body {action, target:'debtors'|{pppoeIds}}   → 200 {total, byRouter, sample}
POST /api/pppoe/enforce/bulk       body {action, target}                        → 202 {jobId}
GET  /api/pppoe/enforce/bulk/:id                                                → 200 {status, total, doneCount, failedCount, items}
```
Permiso `pppoe.cut` (writes de corte) en todas. `PppoeServiceDto` gana `enforcedState` (sigue SIN `password`).

## Limitaciones conocidas (cazadas en el review adversarial, aceptadas para v1)

1. **Drift router/DB**: si el router se cambia POR FUERA de Prominense (admin manual, reboot que recarga un export viejo), la DB sigue siendo la fuente de verdad. El no-op idempotente (`enforcedState===target → return`) NO re-aplica en ese caso. Aceptable para v1 (DB autoritativa); un `force` para reconciliar queda como mejora futura.
2. **Batch huérfano tras reinicio**: si el container muere a mitad del bulk, el `PgAdvisoryLock` se libera solo (Postgres lo suelta al cerrarse la conexión → NO bloquea cortes futuros), pero la fila `ServiceCutBatch` queda en `running` con `finishedAt=null`. NO hay auto-resume ni reaper en v1. Re-correr el batch es SEGURO (idempotencia: los ya-hechos son no-op), pero lo dispara el operador manualmente (coherente con "todo on-demand"). Un reaper-at-boot queda como mejora.
3. **`PgAdvisoryLock` — ventana de reconexión**: el adapter compartido documenta una ventana <60s donde, si la conexión PG dedicada se cae y reconecta, el lock de la sesión vieja ya lo soltó Postgres. Pre-existente (lo usan otros features); fuera del scope de Fase C.
4. **`restore` con `profile` comercial null**: no manda profile vacío al router (lo deja como está). Caso de borde teórico — los PPPoE reales tienen profile comercial. Documentado.
5. **`doneCount` cuenta no-ops como done**: si un pppoe cambió de estado entre el preview y el bulk, `EnforcePppoeService` lo trata como no-op idempotente (ok=true). El `doneCount` cuenta "no requería trabajo" como done. Correcto por diseño.

## Open questions (para apply)

1. `reduce` vs `block`: confirmar el mapeo de estados GR → acción (deudor `late` → `reduce`; baja/incobrable `baja`/`blocked` → `block`). El `target:'debtors'` arranca con `status='late'`.
2. Throttle default (ms entre ops) + concurrencia por router — calibrar con la primera corrida real (arranco conservador: 1 op/router, ~300ms throttle, N routers en paralelo).
3. ¿`restore` masivo dispara solo o también on-demand? → on-demand (mismo patrón; el operador lo dispara cuando GR marca regularizados).
