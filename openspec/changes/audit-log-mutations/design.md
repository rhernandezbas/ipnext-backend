# Design: audit-log-mutations

## Architecture Decisions

### AD-1: Captura híbrida — middleware genérico + AuditService.emit
Dos caminos que escriben en el MISMO `AuditEventRepository`:
- **Middleware genérico** (`auditMutationsMiddleware`): cobertura por defecto de toda mutación. Barato, cero fricción por-route. El "antes" es `req.body` (lo solicitado), el "después" es el response body.
- **`AuditService.emit`** (puerto de aplicación): use cases puntuales emiten `before`/`after` fiel (el estado previo real leído del repo). Reemplaza los 8 stubs `[AUDIT] console.log`.

Razón: el MW solo no puede capturar el estado previo real (requeriría un GET antes de cada mutación); el emit solo obligaría a instrumentar todo a mano. El híbrido da cobertura total + precisión donde el negocio lo pide.

### AD-2: El MW captura en `res.on('finish')`, no en la entrada
`req.user` lo setea el `authMiddleware` **por-router** (no global), así que al ENTRAR el MW global `req.user` todavía no existe. Solución: el MW
1. al entrar, envuelve `res.json` para **capturar el body de respuesta** en `res.locals.__auditBody`;
2. registra `res.on('finish')` y, en ese momento (cuando auth + handler ya corrieron), lee `req.user`, `res.statusCode`, el body capturado, y persiste.

`res.on('finish')` corre después de enviar la respuesta → la auditoría **no agrega latencia percibida** al cliente y **nunca rompe** la request (errores de escritura se loguean, no se propagan).

### AD-3: Dedupe MW ↔ emit vía `res.locals`
`AuditService.emit` setea `res.locals.__auditEmitted = true` (necesita acceso a `res`; el service se obtiene por request o el emit recibe el `res`/un contexto). El handler `finish` del MW: si `__auditEmitted` está, **no** crea el evento genérico (el emit ya escribió uno más rico). Garantiza **un evento por mutación**.

> Nota de implementación: para que `emit` marque `res.locals`, el use case necesita un canal a la request. Se resuelve con un **AuditContext por-request** inyectado en el handler (no en el dominio): el route handler pasa un `emit` ligado a `res` al use case, o el use case recibe un `AuditService` cuya `emit` cierra sobre el `res` de esa request. El dominio define el puerto `AuditService`; la infraestructura provee la instancia request-scoped.

### AD-4: Hexagonal — entity + 2 puertos + adapters + DTO
- `domain/entities/audit.ts`: `AuditEvent`, `AuditEmitInput`.
- `domain/ports/AuditEventRepository.ts`: `record()` + `list(query)` (paginado).
- `domain/ports/AuditService.ts`: `emit(input)`.
- `infrastructure/adapters/prisma/PrismaAuditEventRepository.ts` + `InMemoryAuditEventRepository.ts`.
- `application/use-cases/audit/ListAuditEvents.ts` (paginado + filtros) y `RecordAuditEvent.ts` (usado por el MW vía un wrapper de infraestructura; el MW NO importa Prisma directo — depende del repo port).
- El endpoint mapea a `AuditEventDto` (nunca devuelve la entidad cruda — regla del proyecto).

### AD-5: Masking
Función pura `maskSensitive(obj)` en infraestructura: recorre el objeto y reemplaza por `"***"` los valores de claves en `SENSITIVE_KEYS = ['password','newPassword','currentPassword','token','secret','passwordHash']`. Se aplica a `beforeJson` y `afterJson` en AMBOS caminos (MW y emit). El password en texto plano NUNCA toca la tabla.

### AD-6: Alcance del MW
Audita mutaciones bajo `/api`. NO audita `GET/HEAD/OPTIONS`. Login (`POST /api/auth/login`) SÍ se audita (valioso) pero con password enmascarado. El MW es **siempre activo** (no se condiciona a `NODE_ENV`; recordar que prod corre con `NODE_ENV=development`).

### AD-7: actorLogin snapshot
Se guarda `actorLogin` como snapshot (no solo el FK) para que el registro sobreviva el borrado del usuario (`onDelete: SetNull` deja `actorId` null pero `actorLogin` conserva quién fue). Auditoría = inmutable e independiente del ciclo de vida del actor.

### AD-8: Reemplazo limpio del legacy (FE contrato)
La pestaña "Actividad" del FE pasa a consumir `GET /api/admin/audit-events`. Se elimina el tipo/hook/api `AdminActivityLog`. El mapeo a DTO mantiene campos legibles (actor, acción, entidad, método, status, fecha) + `beforeJson`/`afterJson` para el drawer. NO se rompe ninguna otra parte del FE (la pestaña era el único consumidor).

---

## Migration Strategy

### Migración 1 (aditiva, segura) — crear `AuditEvent`
```sql
CREATE TABLE "AuditEvent" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "actorId"      TEXT REFERENCES "RbacUser"("id") ON DELETE SET NULL,
  "actorLogin"   TEXT NOT NULL,
  "method"       TEXT NOT NULL,
  "path"         TEXT NOT NULL,
  "action"       TEXT,
  "entityType"   TEXT,
  "entityId"     TEXT,
  "beforeJson"   JSONB,
  "afterJson"    JSONB,
  "statusCode"   INTEGER NOT NULL,
  "errorMessage" TEXT,
  "ip"           TEXT,
  "createdAt"    TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX "AuditEvent_actorId_idx"    ON "AuditEvent"("actorId");
CREATE INDEX "AuditEvent_createdAt_idx"  ON "AuditEvent"("createdAt");
CREATE INDEX "AuditEvent_entity_idx"     ON "AuditEvent"("entityType","entityId");
CREATE INDEX "AuditEvent_method_idx"     ON "AuditEvent"("method");
```

### Migración 2 (destructiva) — dropear `AdminActivityLog`
Transaccional, separada y **revisada con el usuario antes del push** (regla de migraciones destructivas). El drop es seguro porque la nueva auditoría arranca de cero (no se migra histórico legacy — decisión MVP; si se quisiera conservar, sería un backfill aparte).
```sql
BEGIN;
DROP TABLE IF EXISTS "AdminActivityLog";
COMMIT;
```
> Decisión a confirmar en apply: ¿se descarta el histórico de `AdminActivityLog` o se backfillea a `AuditEvent`? Propuesta MVP: **descartar** (era curado/parcial). Flag para el usuario.

---

## Testing Strategy (TDD estricto)
- **Use cases** (`ListAuditEvents`, masking, dedupe logic) → in-memory `InMemoryAuditEventRepository`. Red→green.
- **Middleware** → test de Express con supertest: una ruta mutante de prueba + repo in-memory inyectado; assert que se registra el evento con el shape correcto, que GET no audita, que el password se enmascara, que el emit deduplica.
- **Endpoint** `GET /admin/audit-events` → supertest + repo in-memory: paginación, filtros, 403 sin permiso.
- **FE** → Vitest: hook `useAuditEvents`, render de la pestaña + drawer, filtros. Mock del api client.
- **Contract tests** del puerto `AuditEventRepository` (in-memory + Prisma skip-gated), igual que `rbacPermissionContractTests`.

## Open decision for apply
- Histórico legacy: descartar (MVP) vs backfill. → confirmar.
- `AuditService` request-scoping: instancia por-request inyectada en el handler vs middleware que setea `res.locals` y un helper `emitAudit(res, input)`. → resolver en design de la fase 2/3 de apply.
