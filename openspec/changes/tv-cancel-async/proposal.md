<!-- tv-cancel-async — cambio multi-repo (BE acá; FE en ipnext-frontend, misma branch) -->
## Intent
La baja de TV (`POST /gigared/customers/:id/cancel`) era SÍNCRONA y bloqueaba ~15s (N `removeService` secuenciales contra el partner CUA). El usuario apretaba "Dar de baja" y no pasaba nada hasta que el modal aparecía 15s después; si fallaba, no había feedback de error. Hacerla ASÍNCRONA con polling, espejando el patrón fire-and-forget del cierre de OS (#32 BackfillScheduler).

## Cambio (BE)
1. **Migración aditiva `20260720000000`**: `Client += tvCancelStatus String?`, `tvCancelResult Json?`, `tvCancelStartedAt DateTime?`. (20260719 lo tomó recaptacion-v2 → 20260720 para no colisionar.)
2. **`CancelTv` use case INTACTO** — sigue siendo síncrono, hace el trabajo real. El async es una cáscara de infraestructura.
3. **`CancelTvJobRunner`** (fire-and-forget): pending→running→done|failed; nunca tira, persiste el error en `tvCancelStatus`/`tvCancelResult`.
4. **Port `ClientTvCancelStatusRepository`** (getStatus/setStatus) + adapters Prisma + InMemory.
5. **Ruta `POST .../cancel`**: valida cliente+contrato (rápido, sin tocar el partner), guarda contra concurrencia (`tvCancelStatus pending|running` → 409 `already-running`), setea `pending`, responde **202**, dispara el runner.
6. **Ruta nueva `GET .../cancel/status`**: devuelve `{status, result?, startedAt?}`. Gate `tv.cancel`.

## Wire contract (lo consume el FE)
- `POST /api/gigared/customers/:id/cancel` → **202** `{status:'pending'}` (antes 200/207). Concurrente → 409 `{queued:false, reason:'already-running'}`.
- `GET /api/gigared/customers/:id/cancel/status` → `{status:'pending'|'running'|'done'|'failed', result?: CancelTvResult, startedAt?: ISO}`.

## FE (cambio hermano)
Modal pollea el status cada 3s (espejo de `useIClassClosure`): spinner ⏳ → ✓ verde (done OK) / ✗ rojo + ícono de error + motivo (done parcial o failed). La invalidación de contratos se mueve al cierre OK del async (#11: el ítem TV se quita recién entonces). Se elimina el control "Agregar solo el ítem local (sin Gigared)".

## Tests
- Ruta: 202 pending; 409 concurrente; status pending/done/failed. Runner: running→done/failed. WT1 setOtt + WT2 date/clientId verdes (258 tests gigared, 14 suites).

## Rollback
Revertir la ruta a síncrona (await cancelTv.execute), quitar runner/port/status route y los 3 campos del Client (migración down).
