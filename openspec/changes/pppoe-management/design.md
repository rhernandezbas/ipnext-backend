# Design: PPPoE Management (Fase B)

## Contexto

CRUD de `PppoeService` (Fase A) que **aprovisiona el `/ppp secret` real** en el MikroTik. Dos escrituras por operación (fila DB + secret en el router) → el corazón del diseño es la **consistencia** entre ambas. Construye el `adapter RouterOS` que la Fase C reusa para cortar.

## Decisión 1 — Port `PppoeRouterGateway`

```ts
interface RouterSecret {
  username: string; profile: string | null;
  remoteAddress: string | null; disabled: boolean;
}
interface PppoeRouterGateway {
  // Fase B (implementados ahora)
  listSecrets(nas: NasTarget): Promise<RouterSecret[]>;
  createSecret(nas: NasTarget, s: SecretInput): Promise<void>;
  updateSecret(nas: NasTarget, username: string, patch: Partial<SecretInput>): Promise<void>;
  removeSecret(nas: NasTarget, username: string): Promise<void>;
  // Fase C (declarados; se implementan en enforcement)
  listActiveSessions(nas: NasTarget): Promise<ActiveSession[]>;
  removeActiveSession(nas: NasTarget, username: string): Promise<void>;
}
```

- `NasTarget` = `{ ipAddress, apiPort }` (del `NasServer`) + credenciales **server-side** (Decisión 3). El gateway NO recibe el password desde la capa HTTP.
- Adapters: `RouterOsGateway` (node-routeros, write de secret) + `InMemoryRouterGateway` (fake, store por nas, para TDD sin router real).
- DIP: los use cases dependen del **port**, nunca de `node-routeros`.

## Decisión 2 — Consistencia DB↔router (el quid) ⭐

Patrón **DB-pending → router → DB-confirm** (resiliente, estilo `CancelTvJobRunner`):

| Op | Secuencia | Si el router falla |
|----|-----------|--------------------|
| **Create** | insert `status='pending'` → `createSecret` → update `status='enabled'` | queda `pending` + `502 ROUTER_UNREACHABLE`; reintentable (idempotente por `username`) |
| **Update** | `updateSecret` → si OK, update DB | DB no cambia; `502`; el operador reintenta |
| **Move** | `createSecret`(destino) → `removeSecret`(origen) → update `nasId` | si destino falla → aborta, nada cambió; si origen falla tras crear destino → `nasId`=destino + flag `pending` (el secret viejo queda; se limpia en retry) |
| **Deactivate** | `updateSecret disabled=yes` → update `status='disabled'` | `502`; reintentable |

- **Nunca** un "OK" mentiroso: si el router no respondió, el estado lo refleja (`pending`) y es visible/reintentable.
- **Idempotencia**: `createSecret` que choca con un secret existente → trata como `updateSecret` (re-correr no rompe). Upsert por `username` en DB.
- **Descartado**: router-primero-luego-DB → si la DB falla queda un secret huérfano en el router SIN rastro en Prominense (peor: invisible). DB-primero deja siempre rastro.

## Decisión 3 — Credenciales del router server-side

- User/pass del user `prominense` = **env global** (`ROUTER_API_USER`, `ROUTER_API_PASSWORD`) — es el mismo para los 13 routers. Validadas fail-fast en `config.ts`.
- Por router: `NasServer.ipAddress` + `apiPort` (ya existen). `NasServer.apiLogin/apiPassword` quedan como **override opcional** por-router (ya están en el modelo).
- **El password NUNCA sale en un DTO ni viaja al browser.** La UI de admin puede setear/rotar (write-only), nunca leer.

## Decisión 4 — Baja = soft (disabled), no delete

- `Deactivate`: `disabled=yes` en el router + `status='disabled'` en DB. El inventario se conserva (reactivable; histórico). 
- Hard-delete (`removeSecret` + borrar fila) → acción separada super-admin, fuera de scope de B (se agrega si hace falta).

## Decisión 5 — `username` único global

- `username @unique` (Fase A). Check previo en `Create` → `PppoeUsernameTakenError` (409). Un username PPPoE no puede vivir en 2 routers (ambiguo para cortar después).

## Decisión 6 — Wire contract BE↔FE (explícito, campo por campo)

**DTO** `PppoeServiceDto` (lectura, **sin `password`**):
```
{ id, username, profile, remoteAddress, status, nasId, nasName, contractId, createdAt }
```

**Endpoints** (todos con auth; `read`=`pppoe.read`, writes=`pppoe.manage`):
```
GET    /api/contracts/:contractId/pppoe        → PppoeServiceDto[]
POST   /api/contracts/:contractId/pppoe        body {username,password,profile?,remoteAddress?,nasId} → 201 PppoeServiceDto
PATCH  /api/pppoe/:id                           body {profile?,password?,remoteAddress?,status?}       → 200 PppoeServiceDto
POST   /api/pppoe/:id/move                      body {nasId}                                           → 200 PppoeServiceDto
DELETE /api/pppoe/:id                           (baja soft)                                            → 204
```

**Errores** (shape estable para el FE):
```
409 {code:'PPPOE_USERNAME_TAKEN'}   422 {code:'VALIDATION_ERROR', details}
502 {code:'ROUTER_UNREACHABLE'}     404 {code:'PPPOE_NOT_FOUND' | 'CONTRACT_NOT_FOUND' | 'NAS_NOT_FOUND'}
```

## Open questions (para apply)

1. **Profile**: ¿free-text validado, o catálogo de profiles por router (los 7 vistos: `IP-Air-*`, `IP-REDUCCION`, `-PUB`)? → arranco **free-text validado**; catálogo por router = mejora futura.
2. **Move con origen caído**: ¿dejar el secret viejo y limpiar en retry, o exigir ambos routers up? → diseño tolerante (flag `pending`), confirmar en apply.
3. Acceso Sur `10.64.10.2` filtrado → no aprovisiona hasta resolver la ruta.
4. ¿`status` editable libre por PATCH, o solo via Deactivate/reactivar? → restringir a transiciones válidas en el use case.
