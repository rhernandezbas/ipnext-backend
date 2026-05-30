# Proposal — audit-log-mutations (SDD #4)

> Status: PROPOSAL · Artifact store: hybrid · Mode: interactive
> Repos: ipnext-backend (BE) + ipnext-frontend (FE)

## Intent / Why

Hoy la pestaña **"Actividad"** del panel de Administración se alimenta de un modelo
`AdminActivityLog` **curado a mano**: cada acción que se quiere registrar hay que
instrumentarla explícitamente, y está atada al `Admin` legacy (no a `RbacUser`).
Resultado: cobertura parcial, inconsistente y desincronizada del modelo de auth real.

Queremos un **registro de auditoría automático y confiable de todas las mutaciones**
(POST/PUT/PATCH/DELETE) atribuidas al `RbacUser` que las ejecutó, visible y filtrable
desde la misma pestaña. Phase 4a del SDD #3 ya dejó **8 hooks `[AUDIT]` con `TODO(SDD#4)`**
como puntos de enganche.

## Scope

### In
- **BE**: modelo `AuditEvent` + puerto `AuditEventRepository` (write + paginated query) + adapters Prisma/in-memory.
- **BE**: **middleware genérico** de auditoría que captura toda mutación (método, path, actor, body solicitado, response, status, ip) y persiste un `AuditEvent`.
- **BE**: puerto `AuditService` (emit) para **enriquecimiento opcional** desde use cases puntuales (ej. cambios de permisos de rol) con before/after fiel. Reemplaza los 8 stubs `console.log`.
- **BE**: endpoint **`GET /api/admin/audit-events`** paginado + filtros (actor, entityType, method, rango de fechas).
- **BE**: **reemplazo limpio** — deprecar/borrar `AdminActivityLog` (modelo), `GET /admins/activity-log`, `GetAdminActivityLog`. Migración transaccional que dropea la tabla legacy.
- **FE**: migrar la pestaña **"Actividad"** para consumir `AuditEvent` (nuevo hook + API client + tipos), con filtros y un drawer de detalle que muestra el diff.

### Out (explícito)
- Auditoría de **lecturas** (GET) — solo mutaciones.
- Retención/purga automática (se documenta como deuda; MVP guarda todo).
- Escritura **asíncrona** (cola/worker) — MVP es síncrono; se mide latencia y se difiere optimización.
- Migrar `window.prompt`/`window.alert` residuales (fuera de este SDD).

## Approach

### Captura híbrida (decisión del usuario)
1. **Middleware genérico** (cobertura por defecto, bajo costo): se monta después de `express.json`/`cookieParser` y de `authMiddleware`, envolviendo la respuesta para leer `statusCode` + response body. Audita SOLO mutaciones exitosas-y-fallidas (registra el status). El "antes" genérico = `req.body` (lo solicitado); el "después" = response body (el resultado). **Enmascara campos sensibles** (`password`, `token`, `secret`) antes de persistir.
2. **`AuditService.emit()`** (precisión donde importa): puerto en `domain/ports`. Use cases que necesitan before/after fiel (ej. `SetRolePermissions`) lo invocan con el estado previo real. Esto **reemplaza los 8 stubs `[AUDIT] console.log`**. El middleware detecta si ya hubo un emit explícito para esa request y evita duplicar.

### Modelo `AuditEvent` (Prisma)
```
id          uuid @id @default(uuid())
actorId     String        // RbacUser.id (FK, onDelete: SetNull)
actorLogin  String        // snapshot del login al momento (sobrevive si borran al user)
method      String        // POST|PUT|PATCH|DELETE
path        String
action      String?       // nombre semántico (CREATE_RBAC_USER, ...) cuando viene de emit
entityType  String?       // RbacUser | RbacRole | ScheduledTask | ...
entityId    String?
beforeJson  Json?         // estado previo (emit) o req.body enmascarado (MW)
afterJson   Json?         // resultado (response) enmascarado
statusCode  Int
errorMessage String?
ip          String?
createdAt   DateTime @default(now())
@@index([actorId]) @@index([createdAt]) @@index([entityType, entityId]) @@index([method])
```
Hexagonal: `AuditEvent` entity en `domain/entities`, `AuditEventRepository` port en `domain/ports`, adapters `PrismaAuditEventRepository` + `InMemoryAuditEventRepository`. Endpoint devuelve **DTO** (nunca la entidad Prisma cruda).

### Reemplazo limpio del legacy
- Migración: `CREATE TABLE "AuditEvent"` + índices; y **drop transaccional** de `AdminActivityLog` (con guard). Revisar el SQL con el usuario antes del push (regla de migraciones destructivas).
- Borrar `GetAdminActivityLog`, `getActivityLog` del `AdminRepository`, la route legacy.
- FE: `AdminActivityLog` type/hook/api → reemplazados por `auditEvents`. La pestaña "Actividad" mantiene UX (tabla + filtros) pero ahora con columnas de auditoría (actor, acción, entidad, método, status, fecha) + **drawer con el diff** (before/after).

## Phases (tentativo)
1. **BE schema + ports**: `AuditEvent` entity, `AuditEventRepository` + `AuditService` ports, in-memory adapters. Migración (CREATE + DROP legacy, review SQL).
2. **BE captura**: middleware genérico (con masking + dedupe) + Prisma adapter. Montaje en app.ts.
3. **BE emit + cleanup**: `AuditService` Prisma adapter; reemplazar los 8 stubs por emit; `GET /admin/audit-events` (use case `ListAuditEvents` paginado + filtros); borrar legacy (use case/route/repo method).
4. **FE**: tipos + api client + hook `useAuditEvents`; migrar pestaña "Actividad" (tabla + filtros + drawer de diff); borrar `AdminActivityLog` FE.
5. **Verify + deploy**: tests (BE Jest in-memory, FE Vitest) → BE deploy (corre migración) → FE deploy → Playwright smoke de la pestaña Actividad.

## Risks / decisiones resueltas
- **Diff genérico no es estado previo real** → mitigado con `AuditService.emit` en los casos que importan. Documentado.
- **Masking de sensibles** → lista de claves a enmascarar; password jamás se persiste.
- **Orden de middleware** → el audit MW debe ir DESPUÉS del auth MW (necesita `req.user`); si no hay actor, se registra como sistema/anónimo, no se rompe.
- **Performance** (1 write por mutación) → síncrono en MVP, medir; async es Out.
- **`NODE_ENV=development` en prod** → el MW no debe condicionarse a env; siempre activo.
- **Migración destructiva** (drop `AdminActivityLog`) → transaccional, con guard, SQL revisado antes del push.
