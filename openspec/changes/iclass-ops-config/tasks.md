# Tasks — IClass Ops Config

> Change: `iclass-ops-config`. STRICT TDD: por cada item de código, primero el test (red), después la implementación (green), después refactor.
> Tres olas: **A = mapeo técnico↔cuadrilla + auto-asignar** (núcleo, mayor riesgo), **B = toggles de flags** (FE-only), **C = visibilidad del despacho** (read-mostly). B desbloquea la prueba en vivo de A; C es independiente de A y B.

## Ola A — Mapeo Técnico↔Cuadrilla + Auto-asignar (BE + FE)

### Schema + migración + entity/port (RbacUser.iclassTeamLogin)
- [ ] 1. Agregar `iclassTeamLogin String?` a `model RbacUser` en `prisma/schema.prisma` (+ `@@index([iclassTeamLogin])`).
- [ ] 2. Migración aditiva `prisma/migrations/20260727000000_rbac_user_iclass_team_login/migration.sql`: `ALTER TABLE "RbacUser" ADD COLUMN IF NOT EXISTS "iclassTeamLogin" TEXT;` + `CREATE INDEX IF NOT EXISTS ...`. Sin BEGIN/COMMIT, idempotente. NO FK física (soft FK por login, AD-1).
- [ ] 3. Agregar `iclassTeamLogin?: string | null` a `RbacUser` (entity en `src/domain/entities/rbac.ts`) y a `UpdateRbacUserInput` (`RbacUserRepository.ts`).
- [ ] 4. Agregar al port `RbacUserRepository`: `listWithIClassTeam(): Promise<RbacUserWithTeam[]>` (join lógico con `IClassTeam.active`). Asegurar que `findById` devuelve `iclassTeamLogin`.

### Adapters (in-memory primero — TDD)
- [ ] 5. (test E1, A6) `InMemoryRbacUserRepository`: soportar `iclassTeamLogin` en create/update/findById + implementar `listWithIClassTeam` (recibe el catálogo de teams in-memory para el join). Devolver `teamActive`.
- [ ] 6. (test E1) `PrismaRbacUserRepository`: mapear `iclassTeamLogin` en read/update; `listWithIClassTeam` con join a `IClassTeam` por `login`.

### Use cases (mapeo)
- [ ] 7. (test A1-A5) `SetTechnicianTeamMapping`: valida userId existe → si `iclassTeamLogin != null` valida cuadrilla `active && selectable` (sino `IClassTeamNotAssignableError`) → `update(userId, { iclassTeamLogin })`. Depende de `RbacUserRepository` + `IClassTeamRepository`.
- [ ] 8. (test A6) `ListTechnicianTeamMappings`: `listWithIClassTeam()` → mapea a `{ userId, userName, userLogin, iclassTeamLogin, teamName, teamActive }`.

### Auto-asignar (port + use case best-effort)
- [ ] 9. Crear port `src/domain/ports/IClassAutoAssigner.ts` (`maybeAssign(taskId, assigneeId, actor?): Promise<AutoAssignOutcome>`) + tipo `AutoAssignOutcome`.
- [ ] 10. (test B1-B10) `AutoAssignIClassTeamOnTaskUpdate` implementa `IClassAutoAssigner`: pre-checks (flag → orderCode → open → mapping → team active+selectable → `getServiceOrder` no-terminal) → `updateServiceOrder` → recorder `iclass_team_auto_assigned`. NUNCA lanza: errores → `failed` + recorder `iclass_team_auto_assign_failed`. Reusa la lógica de `AssignIClassTeam` (factorizar el camino común si conviene). Depende de Scheduling/IClass/Team/Flag/RbacUser repos + recorder.
- [ ] 11. (test C1-C5) Extender `UpdateTask` con un colaborador opcional `IClassAutoAssigner` (último arg). Invocar `maybeAssign(id, updated.assigneeId, actor)` SOLO si `data.assigneeId !== undefined && updated.assigneeId !== prev.assigneeId`, envuelto en try/catch que NUNCA propaga. Cargar `prev` para este guard si el recorder no lo cargó ya. Sin assigner inyectado → comportamiento idéntico al actual.

### DTO + rutas (mapeo)
- [ ] 12. `src/application/dto/technicianTeamMapping.dto.ts`: zod `{ iclassTeamLogin: string | null }` + mapper a DTO de salida (whitelist).
- [ ] 13. (test F1-F4) Router `iclassTechnicianTeams.routes.ts`: `GET /technician-teams` (gate `iclass.read`) + `PATCH /technician-teams/:userId` (gate `iclass.manage`, zod → 400, 404 user inexistente, 422 cuadrilla no asignable). Montar en `/api/admin/iclass`.

### Wiring + composition root (Ola A)
- [ ] 14. (test E2) En `app.ts`: instanciar `AutoAssignIClassTeamOnTaskUpdate` (reusa `iclassTeamRepo`, `featureFlagRepo`, `buildIClassClient()`, `rbacUserRepo`, `taskActivityRecorder`) e inyectarlo como último arg de `new UpdateTask(...)`. Instanciar `SetTechnicianTeamMapping` + `ListTechnicianTeamMappings` y montar `createIClassTechnicianTeamsRouter`. Actualizar el composition-root test.

### FE (Ola A)
- [ ] 15. Hook `useTechnicianTeamMappings()` (GET) + `useSetTechnicianTeamMapping()` (PATCH) + `technicianTeams.api.ts`. Reusar `useRbacUsers()` y `useIClassTeams()` para poblar.
- [ ] 16. Componente `IClassTechnicianTeamMappingBody.tsx` (clon de `IClassStatusCatalogBody`): tabla editable inline, una fila por técnico, `<select>` de cuadrillas active+selectable, auto-save por fila con feedback ⏳✓⚠. Fila con `teamActive=false` → badge rojo "re-mapeá". Gate `<Can permission="iclass.manage">`.
- [ ] 17. Registrar la sub-tab en `IClassSettingsBody` (`SUB_TABS`): `{ id: 'tecnicos-cuadrillas', label: 'Técnicos → Cuadrillas', content: <IClassTechnicianTeamMappingBody /> }`.

## Ola B — Toggles de feature flags de acciones (FE-only)

- [ ] 18. Verificar (sin cambios BE) que `GET`/`PATCH /api/admin/feature-flags/:key` y `useFeatureFlag`/`useSetFeatureFlag` cubren `iclass-close-action` y `iclass-assign-action`. (Confirmado en exploración — esta tarea es solo el smoke check.)
- [ ] 19. Componente `IClassActionFlagsBody.tsx`: 2 clones de `IClassFlagBody` para `iclass-close-action` y `iclass-assign-action`, con copy contextual (riesgo: nunca probado en vivo, destructivo el cierre). Gate `<Can permission="admin.flags">`.
- [ ] 20. Registrar la sub-tab "Acciones de OS" en `IClassSettingsBody`, SEPARADA de "Integración" (que conserva `iclass-integration`).

## Ola C — Visibilidad del despacho "Qué se envía a IClass" (BE-read + FE)

### BE (read-only)
- [ ] 21. (test D1-D2) Use case `GetIClassDispatchPreview`: lee proyectos con `iclassSoType` → mapea a `DispatchPreviewRow[]` (soType, `nodeResolution='by-customer-city'`, `customerCodeSource`, `phoneSource`, `soCodeSource`, `initialStatus='assigned-by-iclass'`, `hardcoded`). Depende solo de un read del repo de proyectos (port existente o lookup).
- [ ] 22. `src/application/dto/iclassDispatchPreview.dto.ts`: mapper a DTO de salida (whitelist).
- [ ] 23. (test F5-F6) Router `iclassDispatchPreview.routes.ts`: `GET /dispatch-preview` (gate `iclass.read`). Montar en `/api/admin/iclass`.
- [ ] 24. Wiring en `app.ts` + composition-root test.

### FE (Ola C)
- [ ] 25. Hook `useIClassDispatchPreview()` (GET) + `dispatchPreview.api.ts`.
- [ ] 26. Componente `IClassDispatchPreviewBody.tsx` (read-mostly): tabla por proyecto mostrando soType / nodo (resuelto por ciudad) / estado inicial (= IClass) / customerCode-phone-soCode sources, con badges para lo hardcodeado. Links a "Mapeo de proyectos", "Estados de IClass" (catálogo devuelto) y catálogo de nodos. Gate `<Can permission="iclass.read">`.
- [ ] 27. Registrar la sub-tab "Qué se envía a IClass" en `IClassSettingsBody`.

## Verificación final
- [ ] 28. `npm test` verde (todos los scenarios A/B/C/D/E/F de la matriz del design).
- [ ] 29. Prueba en vivo controlada del auto-asignar: con UNA tarea de prueba (con OS), mapear un técnico, flippear `iclass-assign-action` ON, cambiar el assignee, verificar que la cuadrilla llega a IClass y que un fallo simulado NO aborta el update local.
