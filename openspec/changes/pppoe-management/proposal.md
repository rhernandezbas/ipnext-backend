# Proposal: PPPoE Management (Fase B del épico `pppoe-service`)

## Intent

Permitir **cargar y gestionar PPPoE por contrato desde Prominense** (CRUD), **aprovisionando el `/ppp secret` real en el MikroTik** vía RouterOS API. Es la "carga manual" que el usuario hace en la ficha del cliente: una sola carga en Prominense → la red queda sincronizada. Puebla `PppoeService` (Fase A) y deja lista la base (`adapter RouterOS`) que la Fase C reusa para los cortes.

## Why

- La Fase A dejó el **modelo `PppoeService`** pero nada lo puebla (se descartó el import automático: el usuario carga manual).
- Hoy el backend **no tiene adapter MikroTik** (Phase 0 lo confirmó). Sin él no se puede crear/editar un `/ppp secret` ni —después— cortar.
- El operador necesita una pantalla para asociar el PPPoE al contrato (username, password, profile, router, IP fija) sin tocar el router a mano.

## Scope

### In Scope

**Dominio:**
- **Port `PppoeRouterGateway`** — operaciones sobre el router: `listSecrets`, `createSecret`, `updateSecret` (profile/password/remoteAddress/disabled), `removeSecret`, y declarados para Fase C: `listActiveSessions`, `removeActiveSession` (kick). En Fase B se **implementan los de secret**; los de sesión quedan declarados.
- Errores de dominio tipados: `RouterUnreachableError`, `PppoeUsernameTakenError`, etc.

**Aplicación (use cases, TDD con fakes):**
- `CreatePppoeService` — valida + persiste `PppoeService` + aprovisiona el secret en el router del `nasId`.
- `UpdatePppoeService` — edita profile/password/remoteAddress/status + sincroniza al router.
- `MovePppoeServiceToRouter` — cambia de router (crea en el nuevo, borra/disable en el viejo).
- `DeactivatePppoeService` (baja) — `disabled=yes` en el router + `status='disabled'` (soft; no borra el inventario).
- Lectura: `ListPppoeByContract` / `GetPppoeService`.

**Infraestructura:**
- **Adapter `RouterOsGateway`** (implements el port) con `node-routeros`, conexión por `NasServer` (credenciales **server-side**), timeout + error tipado.
- **`InMemoryRouterGateway`** (fake) para tests — no pega a un router real.
- Rutas HTTP: `GET/POST /api/contracts/:contractId/pppoe`, `PATCH/DELETE /api/pppoe/:id`, `POST /api/pppoe/:id/move`. Auth + permisos.
- **Credenciales del router server-side** (Decisión 6 del design A): el user `prominense` va por env/config (mismo para los 13; la IP/puerto por `NasServer`). **Nunca al browser.**

**RBAC:** permisos `pppoe.read` / `pppoe.manage` (catálogo backend + expuestos al `/me` + migración seed idempotente). Guard en ambas capas.

### Out of Scope

- **Cortes masivos / enforcement** (batch, IP-REDUCCION masivo) → **Fase C** (el port declara `removeActiveSession`, pero el motor de batch es C).
- **FE / UI** detallada → trabajo coordinado en `ipnext-frontend` (este change expone los endpoints + DTO; el wire contract va explícito acá).
- **RADIUS CoA** → futuro (el port abstrae; otro adapter más adelante).
- **Reconciliación masiva** router↔Prominense → posterior.

## Capabilities

### New Capabilities
- `pppoe-management`: CRUD de PppoeService con aprovisionamiento RouterOS. Spec fuente de esta capacidad.

### Modified Capabilities
- `pppoe-inventory` (Fase A): se le agregan operaciones de escritura/lectura por contrato (el repo ya existe).

## Approach

1. **Port + adapter RouterOS** primero (base de B y C): `PppoeRouterGateway` + `RouterOsGateway` (write de secret) + `InMemoryRouterGateway`. TDD del adapter con fake de la lib.
2. **Use cases CRUD** con el repo (Fase A) + el gateway, inyectados por port. Decidir en el design la **consistencia DB↔router** (orden de escritura + compensación si una falla) — ver Riesgos.
3. **Rutas + RBAC + DTO** (sin devolver el `password` en lecturas — write-only, igual que las credenciales del NAS).
4. **TDD**: use cases con fakes (router caído, username tomado, baja); rutas con supertest; composition test del wiring en `app.ts`.

## Affected Areas

| Área | Impacto |
|------|---------|
| `src/domain/ports/PppoeRouterGateway.ts` | New — port del router |
| `src/domain/errors/` | New — errores tipados de router/pppoe |
| `src/infrastructure/adapters/routeros/RouterOsGateway.ts` | New — adapter node-routeros |
| `src/infrastructure/adapters/in-memory/InMemoryRouterGateway.ts` | New — fake |
| `src/application/use-cases/CreatePppoeService.ts` (+ Update/Move/Deactivate/List) | New |
| `src/application/dto/pppoe.dto.ts` | New — DTOs + validación (zod, ya en el repo) |
| `src/infrastructure/http/routes/pppoe.routes.ts` | New — CRUD + guards |
| `src/infrastructure/http/app.ts` | Modified — wiring (+ composition test) |
| catálogo RBAC + migración seed `pppoe.read`/`pppoe.manage` | New |
| `package.json` | Modified — `node-routeros` (de devDep a dep, ahora es runtime) |
| `env.example` + `config.ts` | Modified — credenciales router server-side |

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| **Consistencia DB↔router** (una escritura OK, la otra falla) | Alta | Diseñar orden + compensación en el design; upsert idempotente por `username`; estado `pending`/error visible; nunca dejar DB y router divergentes en silencio |
| Aprovisionar a un router caído | Media | Error tipado `RouterUnreachableError` → 502 claro; NO persistir como "OK"; reintentable |
| Credenciales del router en el browser | Media | Decisión 6: server-side estricto; el GET no devuelve password (write-only) |
| `node-routeros` pasa a runtime de la app | Media | Encapsulado tras el port (DIP); fake para tests; timeout/retry |
| Username PPPoE duplicado entre routers | Media | `username @unique` en DB + check previo → `PppoeUsernameTakenError` |
| Acceso Sur `10.64.10.2` filtrado | Baja | Documentado; ese router no aprovisiona hasta resolver la ruta |

## Rollback

Aditivo (tabla ya existe de Fase A; rutas/use-cases nuevos). Rollback = `git revert` del merge. Las filas `PppoeService` creadas quedan (inertes si se revierte el código). Los `/ppp secret` aprovisionados en routers **no** se revierten con git — documentar que un revert no des-aprovisiona la red (operación manual si hiciera falta).

## Dependencies

- Fase A (`PppoeService` + repo) — hecha en `feat/pppoe-foundation`. El apply de B se encadena sobre A (worktree desde esa branch, o tras mergear A a main).
- `node-routeros` (runtime).
- Credenciales del user `prominense` cargadas server-side (env/config).
- Conectividad a los routers (12/13 OK; Acceso Sur pendiente).

## Success Criteria

- [ ] `POST /api/contracts/:id/pppoe` crea el `PppoeService` Y el `/ppp secret` en el router correcto.
- [ ] `PATCH /api/pppoe/:id` edita profile/password/remoteAddress y lo sincroniza al router.
- [ ] `POST /api/pppoe/:id/move` mueve de router (crea en destino, baja en origen) de forma consistente.
- [ ] `DELETE` (baja) deja `disabled=yes` en el router + `status='disabled'` (soft).
- [ ] Router caído → error claro (502), sin estado DB↔router divergente.
- [ ] El `password` nunca viaja en respuestas de lectura.
- [ ] 401 sin auth / 403 sin `pppoe.manage`.
- [ ] `npm test` verde + `tsc --noEmit` limpio; DIP preservado (use cases no importan `node-routeros`).
- [ ] Composition test pinea el wiring en `app.ts`.
- [ ] Wire contract BE↔FE documentado (endpoints + DTO campo por campo) para el equipo FE.
