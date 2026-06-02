# Spec: RBAC — Permiso iclass_manual_resend

**Capability**: `rbac-iclass-manual-resend` (NEW)
**Change**: `iclass-manual-node-resend`
**Summary**: Nueva action `iclass_manual_resend` en el modulo `scheduling` del catalogo RBAC.
La action se siembra como `RbacPermission` y se concede a `super_admin` via migration
idempotente. Solo super_admin (y usuarios con `*`) pueden reenviar tareas a IClass.

RFC 2119 keywords: MUST, MUST NOT, SHOULD, SHOULD NOT, MAY.

---

## Entities modificadas

### `KNOWN_ACTIONS` (catalogo RBAC en `src/domain/entities/rbac.ts`)

El catalogo MUST agregar `'iclass_manual_resend'` a la seccion de sub-actions del
modulo `scheduling`.

```ts
// Antes (ejemplo representativo)
scheduling: ['read', 'manage', ...],

// Despues
scheduling: ['read', 'manage', ..., 'iclass_manual_resend'],
```

- La action MUST llamarse exactamente `iclass_manual_resend` (sin guiones, en snake_case).
- La action MUST vivir en el modulo `scheduling` (no en `iclass` ni en ningun otro modulo).

---

## Requirements

### REQ-RBAC-RESEND-1: Action en el catalogo `KNOWN_ACTIONS`

`src/domain/entities/rbac.ts` MUST incluir `'iclass_manual_resend'` en el array de
actions del modulo `scheduling`.

- TypeScript MUST inferir el tipo de la action correctamente (si `KNOWN_ACTIONS`
  se usa para inferir union types, la nueva action MUST aparecer en la union).
- `tsc --noEmit` MUST pasar con 0 errores tras el cambio.

#### Scenario: TypeScript reconoce la nueva action

**Given** `requirePerm('scheduling', 'iclass_manual_resend')` en el codigo de rutas
**When** `tsc --noEmit` se ejecuta
**Then** MUST compilar sin errores de tipo
**And** MUST NOT producir error `"Argument of type 'iclass_manual_resend' is not assignable"`

---

### REQ-RBAC-RESEND-2: Migration — sembrar `RbacPermission`

MUST existir una migration Prisma idempotente (timestamp posterior a `20260603000000`)
que inserte la fila de permission en la tabla `RbacPermission`:

```sql
INSERT INTO "RbacPermission" ("id", "module", "action")
VALUES (gen_random_uuid(), 'scheduling', 'iclass_manual_resend')
ON CONFLICT DO NOTHING;
```

- El `ON CONFLICT DO NOTHING` garantiza idempotencia: re-ejecutar la migration MUST
  NO duplicar la fila.
- La migration MUST poder ejecutarse con `prisma migrate deploy`.

#### Scenario: Migration siembra la permission

**Given** una base de datos sin la fila `(scheduling, iclass_manual_resend)` en `RbacPermission`
**When** la migration se ejecuta
**Then** MUST existir la fila `{ module: "scheduling", action: "iclass_manual_resend" }` en `RbacPermission`

#### Scenario: Migration es idempotente

**Given** la fila `(scheduling, iclass_manual_resend)` ya existente en `RbacPermission`
**When** la migration se ejecuta nuevamente
**Then** MUST seguir existiendo exactamente UNA fila para esa combinacion (no duplicada)

---

### REQ-RBAC-RESEND-3: Migration — grant a `super_admin`

La misma migration (o una migration posterior en la misma secuencia) MUST conceder
`iclass_manual_resend` al rol `super_admin` via CROSS JOIN idempotente, siguiendo
el patron de `20260529200000`:

```sql
INSERT INTO "RolePermission" ("id", "roleId", "permissionId")
SELECT gen_random_uuid(), r.id, p.id
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
WHERE r.name = 'super_admin'
  AND p.module = 'scheduling'
  AND p.action = 'iclass_manual_resend'
ON CONFLICT DO NOTHING;
```

- El `ON CONFLICT DO NOTHING` garantiza idempotencia.
- MUST NOT depender del `id` hardcodeado del role o la permission (usar SELECT).

#### Scenario: super_admin recibe el grant al ejecutar la migration

**Given** el rol `super_admin` existente y la permission `(scheduling, iclass_manual_resend)` ya sembrada
**When** la migration de grant se ejecuta
**Then** MUST existir una fila en `RolePermission` asociando `super_admin` con `iclass_manual_resend`

#### Scenario: Grant idempotente no duplica la asignacion

**Given** `super_admin` ya tiene el grant de `iclass_manual_resend`
**When** la migration se ejecuta nuevamente
**Then** MUST existir exactamente UNA fila del grant (no duplicada)

---

### REQ-RBAC-RESEND-4: Guard en ambos endpoints

`requirePerm('scheduling', 'iclass_manual_resend')` MUST aplicarse en:

- `GET /api/scheduling/iclass/nodes`
- `POST /api/scheduling/:id/iclass/resend`

El guard MUST encadenarse DESPUES del middleware `auth` y ANTES del handler.

#### Scenario: super_admin pasa el guard en ambos endpoints

**Given** un usuario con rol `super_admin`
**When** llama a `GET /api/scheduling/iclass/nodes` o `POST /api/scheduling/:id/iclass/resend`
**Then** el short-circuit de `super_admin` en `requirePermission` MUST permitir el acceso
**And** la respuesta MUST ser 200 (o el codigo esperado del handler)

#### Scenario: Usuario con permiso explicito pasa el guard

**Given** un usuario que tiene el permiso `scheduling.iclass_manual_resend` asignado via rol
**When** llama a cualquiera de los dos endpoints
**Then** MUST pasar el guard y llegar al handler

#### Scenario: Usuario sin el permiso recibe 403 en ambos endpoints

**Given** un usuario autenticado sin el permiso `scheduling.iclass_manual_resend`
**When** llama a `GET /api/scheduling/iclass/nodes`
**Then** la respuesta MUST ser 403 con `{ "code": "PERMISSION_DENIED" }`

**Given** un usuario autenticado sin el permiso `scheduling.iclass_manual_resend`
**When** llama a `POST /api/scheduling/:id/iclass/resend`
**Then** la respuesta MUST ser 403 con `{ "code": "PERMISSION_DENIED" }`

#### Scenario: Sin token recibe 401 en ambos endpoints

**Given** una request sin cookie `auth_token`
**When** llama a cualquiera de los dos endpoints
**Then** la respuesta MUST ser 401 (el middleware `auth` rechaza antes del guard de permiso)

---

### REQ-RBAC-RESEND-5: Solo super_admin puede usar el reenvio (por diseno)

El permiso `iclass_manual_resend` MUST concederse UNICAMENTE a `super_admin` por
defecto (via la migration). Ningun otro rol MUST recibir este permiso en el seed ni
en la migration de este change.

- Otros roles podran recibir el permiso en el futuro si el negocio lo requiere,
  pero eso esta fuera del scope de este change.
- La concesion a `*` (wildcard) aplica solo al mecanismo interno de super_admin
  (short-circuit en `requirePermission`); no es una asignacion de BBDD.

---

## Appendix: Codigos de error HTTP para guards RBAC

| Condicion                                         | HTTP | `code`              |
| ------------------------------------------------- | ---- | ------------------- |
| Sin token (`auth` middleware falla)               | 401  | `NO_USER_CONTEXT`   |
| Con token pero sin permiso `iclass_manual_resend` | 403  | `PERMISSION_DENIED` |
