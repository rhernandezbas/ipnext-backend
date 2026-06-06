# Tasks: activity-watcher-names (#17) — Approach B

## Phase BE (TDD red→green; deploy WAITS for audit reprocess 76/76)

- [x] 1. `domain/ports/EntityLookup.ts`: `findById(id): Promise<{ id: string; name?: string } | null>` (name opcional, retrocompatible).
- [x] 2. `computeUpdateTaskActivities`: param opcional `watcherNames?: Record<string,string>` → watcher_added `metadata.toName`, watcher_removed `metadata.fromName`; sin map, igual que antes. (RED→GREEN, 17/17.)
- [x] 3. `UpdateTask`: resuelve `Record<id,name>` de la UNIÓN `prev.watcherIds ∪ data.watcherIds` vía `adminLookup.findById` y lo pasa al diff engine. (RED→GREEN, +NamedLookup en el test.)
- [x] 4. `infrastructure/http/app.ts`: `userLookupForScheduling` devuelve `{ id, name: rbacUser.name }`.
- [x] 5. Suite completa `npx jest --runInBand` = **2376 passed, 0 failed**; `tsc --noEmit` = exit 0.
- [ ] 6. Commit por paths explícitos. **Deploy: el reprocess está DETENIDO (60/76) → ventana abierta, sin conflicto.**

## Phase FE (después de mergear el BE)

- [ ] 7. `taskActivityLabel.ts` (`describeActivity`):
  - RED: test — `watcher_added` con `metadata.toName` → "agregó a {name}"; sin `toName` → "agregó un observador". Idem `watcher_removed`/`fromName`.
  - GREEN: usar `m.toName`/`m.fromName` con fallback.
- [ ] 8. `npm run typecheck` + `npx vitest run` verdes.
- [ ] 9. Commit + deploy FE.

## Verify
- [ ] 10. `/sdd-verify`: spec compliance (3 scenarios) contra los tests que pasaron.
