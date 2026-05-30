# Spec: Audit Log

**Capability**: `audit-log` (NEW)
**Change**: `audit-log-mutations`
**Summary**: Auditoría automática de mutaciones (POST/PUT/PATCH/DELETE) atribuidas al `RbacUser` que las ejecuta, persistida en `AuditEvent`, consultable y filtrable. Captura híbrida: middleware genérico + `AuditService.emit` para before/after fiel. Reemplaza el `AdminActivityLog` legacy.

---

## Added Requirements

### REQ-AUD-MODEL-1: Modelo y puerto

El sistema MUST persistir eventos en una tabla `AuditEvent` con: `id` (uuid), `actorId` (FK→`RbacUser`, `onDelete: SetNull`), `actorLogin` (snapshot string), `method`, `path`, `action` (nullable), `entityType` (nullable), `entityId` (nullable), `beforeJson` (Json nullable), `afterJson` (Json nullable), `statusCode` (int), `errorMessage` (nullable), `ip` (nullable), `createdAt`. MUST indexar `actorId`, `createdAt`, `(entityType, entityId)`, `method`.

El dominio MUST exponer en `src/domain/ports/`:

```ts
interface AuditEvent {
  id: string; actorId: string | null; actorLogin: string;
  method: string; path: string; action: string | null;
  entityType: string | null; entityId: string | null;
  beforeJson: unknown | null; afterJson: unknown | null;
  statusCode: number; errorMessage: string | null;
  ip: string | null; createdAt: string;
}
interface AuditEventQuery { actorId?: string; entityType?: string; method?: string; from?: string; to?: string; page?: number; pageSize?: number; }
interface AuditEventRepository {
  record(event: Omit<AuditEvent, 'id' | 'createdAt'>): Promise<AuditEvent>;
  list(query: AuditEventQuery): Promise<{ items: AuditEvent[]; total: number; page: number; pageSize: number }>;
}
interface AuditService { emit(input: AuditEmitInput): Promise<void>; } // before/after fiel desde use cases
```

### REQ-AUD-CAPTURE-1: Captura genérica de mutaciones

El sistema MUST registrar un `AuditEvent` por cada request mutante (`POST`/`PUT`/`PATCH`/`DELETE`) bajo `/api`, leyendo `actorId`/`actorLogin` de `req.user` al finalizar la respuesta. NO MUST auditar requests `GET`/`HEAD`/`OPTIONS`.

#### Scenario: Una mutación exitosa genera un evento
**Given** un `POST /api/admin/rbac/users` autenticado que responde 201
**When** la respuesta finaliza
**Then** MUST persistirse un `AuditEvent` con `method: "POST"`, el `path`, `statusCode: 201`, `actorId`/`actorLogin` del usuario, y `afterJson` con el body de respuesta

#### Scenario: Una mutación fallida también se registra
**Given** un `DELETE /api/admin/rbac/users/:id` que responde 403
**When** la respuesta finaliza
**Then** MUST persistirse un `AuditEvent` con `statusCode: 403` y `errorMessage` poblado desde el body de error

#### Scenario: Las lecturas NO se auditan
**Given** un `GET /api/admin/rbac/users`
**When** la respuesta finaliza
**Then** NO MUST crearse ningún `AuditEvent`

#### Scenario: Sin actor no rompe
**Given** una mutación sin `req.user` (ruta sin auth o token inválido que igual ejecuta)
**When** la respuesta finaliza
**Then** el `AuditEvent` MUST registrarse con `actorId: null` y `actorLogin: "anonymous"` (la auditoría NUNCA rompe la request)

### REQ-AUD-MASK-1: Enmascarado de datos sensibles

El sistema MUST enmascarar (`"***"`) los valores de claves sensibles (`password`, `newPassword`, `token`, `secret`, `passwordHash`) en `beforeJson` y `afterJson` antes de persistir. El valor del password MUST NOT quedar nunca en la tabla.

#### Scenario: El password no se persiste
**Given** un `POST /api/admin/rbac/users` con body `{ login, password: "secreto" }`
**When** se audita
**Then** `beforeJson.password` MUST ser `"***"` (nunca `"secreto"`)

### REQ-AUD-EMIT-1: Enriquecimiento por use-case + dedupe

Use cases MAY invocar `AuditService.emit({ action, entityType, entityId, before, after })` para registrar el estado previo real. Cuando un use case emite, el middleware genérico NO MUST crear un segundo evento para esa request (dedupe vía marca en `res.locals`).

#### Scenario: SetRolePermissions emite before/after fiel
**Given** un `PUT /api/admin/rbac/roles/:id/permissions` que cambia permisos
**When** el use case `SetRolePermissions` llama a `AuditService.emit` con los permisos previos y nuevos
**Then** MUST persistirse UN solo `AuditEvent` con `action: "SET_ROLE_PERMISSIONS"`, `beforeJson` = permisos previos, `afterJson` = permisos nuevos
**And** el middleware genérico NO MUST crear un evento duplicado

### REQ-AUD-QUERY-1: Consulta paginada y filtrada

El sistema MUST exponer `GET /api/admin/audit-events` protegido por `requirePerm('admin', 'view_activity_log')`, paginado, ordenado por `createdAt DESC`, devolviendo **DTOs** (nunca la entidad Prisma cruda).

#### Scenario: Listado paginado
**Given** un `GET /api/admin/audit-events?page=1&pageSize=50` autenticado y con permiso
**When** se procesa
**Then** MUST responder 200 con `{ items: AuditEventDto[], total, page, pageSize }` ordenado por fecha desc

#### Scenario: Filtros
**Given** un `GET /api/admin/audit-events?actorId=<id>&entityType=RbacUser&method=DELETE&from=2026-05-01&to=2026-05-31`
**When** se procesa
**Then** MUST responder 200 solo con eventos que matchean TODOS los filtros

#### Scenario: Sin permiso
**Given** un `GET /api/admin/audit-events` de un usuario sin `admin.view_activity_log`
**When** se procesa
**Then** MUST responder 403

### REQ-AUD-LEGACY-1: Reemplazo del AdminActivityLog

El sistema MUST eliminar la capacidad legacy: la tabla `AdminActivityLog`, el endpoint `GET /api/admins/activity-log`, el use case `GetAdminActivityLog` y el método `AdminRepository.getActivityLog`. La migración de drop MUST ser transaccional.

#### Scenario: El endpoint legacy deja de existir
**Given** un `GET /api/admins/activity-log`
**When** se procesa
**Then** MUST responder 404 (ruta removida)

### REQ-AUD-FE-1: Pestaña Actividad sobre AuditEvent

El FE MUST migrar la pestaña "Actividad" del panel de Administración para consumir `GET /api/admin/audit-events` con filtros (actor, entityType, método, rango de fechas) y un **drawer de detalle** que muestre el diff (`beforeJson`/`afterJson`). El tipo/hook/api `AdminActivityLog` legacy MUST ser removido.

#### Scenario: La pestaña lista eventos de auditoría
**Given** un admin con permiso abre la pestaña "Actividad"
**When** carga
**Then** MUST mostrar una tabla paginada de eventos (actor, acción/método, entidad, status, fecha) con filtros

#### Scenario: Drawer de diff
**Given** un evento con `beforeJson`/`afterJson`
**When** el admin lo abre
**Then** MUST mostrar el antes/después en un drawer

---

## Appendix: Error Codes / Status

| Scenario | HTTP | `code` |
|----------|------|--------|
| Consulta sin permiso | 403 | (requirePerm) |
| Endpoint legacy removido | 404 | — |
| Filtros inválidos (fecha mal formada) | 400 | `VALIDATION_ERROR` |
