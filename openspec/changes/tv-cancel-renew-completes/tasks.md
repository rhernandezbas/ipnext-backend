# Tasks: tv-cancel-renew-completes (#74)

## BE (worktree tv-renew-complete-be, branch fix/74-renew-completes)
- [ ] T1 (RED): Test seam route→use case en `src/__tests__/` — caso #2: `ottDisabled=false` + renew OK → **200** (hoy 207). Supertest sobre app con repos in-memory.
- [ ] T2 (RED): Test caso #4: renew fallido (`renew=null`) + `ottDisabled=false` → sigue **207**.
- [ ] T3 (RED): Test caso #5: `renewAttempted=false` + `ottDisabled=false` → **207** (OTT viejo activo, sin renew).
- [ ] T4 (GREEN): Actualizar criterio `partial` en `src/infrastructure/http/routes/gigared.routes.ts` L364-368 con `renewSucceeded`. Actualizar comentario L350-359.
- [ ] T5: Actualizar doc del veredicto en `src/application/dto/gigared.dto.ts` L51 + comentario de CancelTv.ts L80-82.
- [ ] T6: `npx tsc --noEmit` limpio.

## FE (worktree tv-renew-complete-fe, branch fix/74-renew-completes)
- [ ] T7: Completar el tipo `CancelTvResult` en `src/types/gigared.ts` con `renew`, `renewAttempted`, `localCancelled`.
- [ ] T8 (RED): Test en `src/__tests__/customers/GigaredPanel.test.tsx` — renew OK + `ottDisabled=false` → banner ÉXITO (no parcial), sin "OTT sigue activo".
- [ ] T9 (RED): Test — renew fallido / sin renew + `ottDisabled=false` → banner parcial.
- [ ] T10 (GREEN): Actualizar `cancelPartial` (L918-922) con el criterio `renewSucceeded`.
- [ ] T11 (GREEN): Copy: banner éxito menciona "Cuenta reiniciada (CIC nuevo) — el acceso anterior queda invalidado"; banner parcial reporta OTT solo si `!renewSucceeded`.
- [ ] T12: `npm run typecheck` limpio + vitest targeted del GigaredPanel.

## Verify
- [ ] T13: Suite targeted gigared BE + FE. Commits propios por repo (NO push, NO main).
