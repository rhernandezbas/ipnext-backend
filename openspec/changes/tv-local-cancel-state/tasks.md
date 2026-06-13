# Tasks — tv-local-cancel-state

## Backend (worktree tv-local-cancel-be, branch fix/72-tv-local-cancel)
- [x] Schema: `Client.tvCancelledAt DateTime?`
- [x] Migración aditiva idempotente `20260712000000_client_tv_cancelled_at`
- [x] Port `ClientTvCancellationRepository` (mark/clear/isCancelled)
- [x] `PrismaClientTvCancellationRepository`
- [x] `InMemoryClientTvCancellationRepository` (+ test)
- [x] `CancelTv`: anti-coining guard + markCancelled + quitar unlink muerto + `localCancelled`
- [x] `CancelTvResult` DTO: `unlinked` → `localCancelled`
- [x] `GetGigaredCustomerAccount`: isCancelled → linked:false
- [x] `LinkCustomerToCic` / `RegisterGigaredAccount`: clearCancelled best-effort
- [x] Router: criterio 207 sin `!unlinked`
- [x] Wiring app.ts (4 use cases)
- [x] Tests: CancelTv (29), GigaredAccount (36), InMemory adapter (7), routes (77) — verdes
- [x] `tsc --noEmit` limpio

## Frontend (worktree tv-local-cancel-fe, branch fix/72-tv-local-cancel)
- [x] `types/gigared.ts`: `unlinked` → `localCancelled` + JSDoc
- [x] `GigaredPanel.tsx`: copy del confirm sin "desvinculación"; CIC informativo (cupo
      reciclado); línea "Cuenta liberada — el cliente queda sin TV"; cero lecturas de `.unlinked`
- [x] Tests: GigaredPanel (122), gigared.api (15), useGigared (12) — verdes
- [x] `tsc --noEmit` limpio

## Gates
- [x] BE: jest targeted 149/149 + tsc clean
- [x] FE: vitest targeted 149/149 + tsc clean

## Pending (fuera de este change)
- [ ] Escalar a Gigared: pedir endpoint de desasociación/borrado de internal_id (DELETE)
      o baja de cuenta. Mientras tanto la baja local es la semántica honesta.
