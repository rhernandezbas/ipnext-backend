# Tasks: audit-log-mutations

> TDD estricto: en cada fase, tests RED → impl GREEN → refactor. BE = ipnext-backend, FE = ipnext-frontend.
> Commits independientes por repo, push = PROD (confirmar cada uno). No `npm run build`.

## Phase 1 — BE: schema + dominio + puertos + in-memory (sin riesgo)

### T-1: Dominio
- [ ] `src/domain/entities/audit.ts` — `AuditEvent`, `AuditEmitInput`, `AuditEventQuery`
- [ ] `src/domain/ports/AuditEventRepository.ts` — `record()` + `list(query)` (paginado)
- [ ] `src/domain/ports/AuditService.ts` — `emit(input)`

### T-2: Tests RED (use cases + adapter contract)
- [ ] `src/__tests__/application/audit/ListAuditEvents.test.ts` (in-memory: paginación + filtros actor/entityType/method/fecha)
- [ ] `src/__tests__/infrastructure/adapters/_shared/auditEventContractTests.ts` + in-memory runner (record + list shape)

### T-3: Application + in-memory adapter (GREEN)
- [ ] `src/application/use-cases/audit/ListAuditEvents.ts` (filtros + paginación + map a DTO)
- [ ] `src/application/dto/audit.dto.ts` — `AuditEventDto` + Zod del query
- [ ] `src/infrastructure/adapters/in-memory/InMemoryAuditEventRepository.ts`

### T-4: schema.prisma + migración M1 (aditiva)
- [ ] Agregar `model AuditEvent` (uuid, actorId FK→RbacUser SetNull, actorLogin, method, path, action?, entityType?, entityId?, beforeJson Json?, afterJson Json?, statusCode, errorMessage?, ip?, createdAt + 4 índices)
- [ ] Relación inversa en `RbacUser` (`auditEvents AuditEvent[]`)
- [ ] Generar SQL con `prisma migrate diff --from-schema HEAD --to-schema` (sin DB local), revisar, crear `prisma/migrations/<ts>_audit_event/migration.sql`

### T-5: Cierre Phase 1
- [ ] `npx jest` (audit) verde + `npx tsc --noEmit` limpio
- [ ] Commit BE: `feat(audit): AuditEvent model + ports + in-memory + ListAuditEvents (Phase 1)`

## Phase 2 — BE: captura genérica (middleware)

### T-6: Tests RED (middleware)
- [ ] `src/__tests__/infrastructure/http/auditMutations.middleware.test.ts` (supertest, ruta mutante de prueba + repo in-memory): POST exitoso registra evento; GET no audita; 403 registra status+error; sin actor → `anonymous`; password enmascarado

### T-7: Middleware (GREEN)
- [ ] `src/infrastructure/http/middleware/auditMutationsMiddleware.ts` — wrap `res.json`, `res.on('finish')`, lee `req.user`/status/body, dedupe `res.locals.__auditEmitted`
- [ ] `src/infrastructure/http/middleware/maskSensitive.ts` — `maskSensitive(obj)` puro + `SENSITIVE_KEYS`
- [ ] Montar en `app.ts` después de `express.json`/`cookieParser`, antes de los routers

### T-8: Prisma adapter
- [ ] `src/infrastructure/adapters/prisma/PrismaAuditEventRepository.ts` (record + list paginado, índices)
- [ ] Wire en `app.ts` (repo real al middleware)

### T-9: Cierre Phase 2
- [ ] `npx jest` verde + `tsc` limpio
- [ ] Commit BE: `feat(audit): generic mutation audit middleware + masking + Prisma adapter (Phase 2)`

## Phase 3 — BE: emit + endpoint + cleanup legacy

### T-10: Tests RED (emit/dedupe + endpoint + legacy gone)
- [ ] Test: `SetRolePermissions` emite before/after y el MW NO duplica (un solo evento)
- [ ] `src/__tests__/infrastructure/http/auditEvents.routes.test.ts` (GET /admin/audit-events: paginación, filtros, 403 sin permiso)
- [ ] Test: `GET /api/admins/activity-log` → 404 (ruta removida)

### T-11: AuditService + emit en use cases (GREEN)
- [ ] `src/infrastructure/.../AuditServiceImpl` request-scoped (marca `res.locals.__auditEmitted`) — resolver mecanismo (instancia por-request vs helper `emitAudit(res,input)`)
- [ ] Reemplazar los 8 stubs `[AUDIT] console.log` (rbacUser.routes ×7 + rolePermissions.routes ×1) por `emit` con before/after donde aplique (mínimo `SetRolePermissions`)

### T-12: Endpoint de consulta
- [ ] `src/infrastructure/http/routes/auditEvents.routes.ts` — `GET /admin/audit-events` con `requirePerm('admin','view_activity_log')`, paginado, filtros, DTO
- [ ] Wire en `app.ts`

### T-13: Cleanup legacy
- [ ] Borrar `GetAdminActivityLog` use case, `AdminRepository.getActivityLog` (+ in-memory/prisma impl), route `GET /admins/activity-log`
- [ ] Migración M2 (destructiva, transaccional): `DROP TABLE AdminActivityLog` + quitar modelo del schema. **Revisar SQL con el usuario antes del push.**
- [ ] Decisión histórico: descartar (MVP) — confirmado

### T-14: Cierre Phase 3
- [ ] `npx jest` verde + `tsc` limpio
- [ ] Commit BE: `feat(audit): AuditService emit + GET /admin/audit-events + remove legacy AdminActivityLog (Phase 3)`

## Phase 4 — FE: pestaña Actividad sobre AuditEvent

### T-15: Tests RED (FE Vitest)
- [ ] `useAuditEvents` hook test (mock api, filtros, paginación)
- [ ] Test de la pestaña Actividad (render tabla + filtros + drawer de diff)

### T-16: Tipos + api + hook (GREEN)
- [ ] `src/types/audit.ts` — `AuditEventDto`
- [ ] `src/api/auditEvents.api.ts` — `list(query)`
- [ ] `src/hooks/useAuditEvents.ts` (TanStack Query, filtros)

### T-17: UI
- [ ] Migrar pestaña "Actividad" en `AdminPage.tsx` a `useAuditEvents` (tabla: actor, acción/método, entidad, status, fecha + filtros)
- [ ] Drawer de detalle con diff (`beforeJson`/`afterJson`)
- [ ] Borrar `AdminActivityLog` type/hook/api legacy del FE

### T-18: Cierre Phase 4
- [ ] `npx vitest run` verde
- [ ] Commit FE: `feat(admin): pestaña Actividad sobre AuditEvent + drawer de diff (Phase 4)`

## Phase 5 — Verify + deploy

### T-19: Verify
- [ ] `/sdd-verify` contra spec + tasks
- [ ] Suite completa BE (`npx jest`) + FE (`npx vitest run`) verde

### T-20: Deploy (gates de push, uno por uno)
- [ ] Push BE → seguir `gh run watch` (incluye migración M1 + M2). Confirmar step de migraciones verde.
- [ ] Push FE → `gh run watch`
- [ ] Playwright smoke en prod: ejecutar una mutación (no destructiva), ver el evento en la pestaña Actividad + drawer de diff. Limpiar datos de prueba.

### T-21: Archive
- [ ] `/sdd-archive` — sync delta spec → openspec/specs/audit-log/, mover change a archive/
