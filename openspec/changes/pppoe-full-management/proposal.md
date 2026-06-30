# Proposal: Gestión FULL de PPPoE — tab nuevo en Gestión de Red (winbox-style, directo al HA)

## Intent

Crear una **page nueva** de gestión completa de PPPoE — un **tab "PPPoE"** dentro de `GestionRedPage` (Gestión de Red) — que replique la utilidad de la vista `/ppp secret` de winbox del MikroTik, pero con nuestras convenciones y operando **directo contra el RADIUS HA** (vía el orchestrator ya cableado). El operador de red ve TODOS los secrets PPPoE (con y sin contrato), los filtra por NAS, navega paginado, y opera el CRUD por fila.

## Why

Hoy la gestión de PPPoE está fragmentada y atada al cliente/contrato:

- **`InternetPanel.tsx`** — CRUD de PPPoE dentro de la ficha de UN contrato. Sirve para el alta/baja por cliente, no para operar la red.
- **`InternetServicesPage`** (`/admin/customers/internet`) — lista global paginada PERO filtra `contractId IS NOT NULL` → **esconde los secrets sin contrato** (huérfanos), que es justo lo que el admin de red necesita ver y reparar.

Falta una vista **operativa de RED**: todos los PPPoE en una tabla, filtrable por NAS, paginada, con acciones rápidas (cambiar pass/plan/IP, mover de NAS, suspender, baja, recrear con otro username). Es lo que el admin hace hoy entrando por winbox a cada router — lo queremos centralizado en Prominense y consistente con el RADIUS HA.

## Scope

### In Scope

**Backend (aditivo, sin romper contratos existentes):**

1. **Flag `includeUnassigned`** en `ListAllPppoeServices` + `PrismaPppoeServiceRepository.listAllPaginated` (+ in-memory): cuando viene `true`, NO se aplica el filtro `contractId IS NOT NULL` → la lista incluye huérfanos. **Default `false`** = comportamiento actual intacto (`InternetServicesPage` no cambia). El DTO marca los huérfanos (sin cliente → `clientId/customerName = null`).
2. **Create standalone con contrato opcional** — nueva ruta `POST /api/pppoe` (gate `pppoe.manage`) → use case `CreatePppoeStandalone` (o `CreatePppoeService` extendido con `contractId?`): crea en el orchestrator (`POST /users`: username, password, plan, framedIp opcional) + espejo `PppoeService` con `contractId` nullable. Si no se pasa contrato, queda huérfano (⚠).
3. **Recrear username** — use case `RenamePppoeUsername` (gate `pppoe.manage`), ruta `POST /api/pppoe/:id/rename`: **create-then-delete** — crea el secret nuevo en el orchestrator (preservando password/plan/framedIp/MAC/status del viejo) → verifica → borra el viejo → actualiza `PppoeService.username` (mismo row → preserva `contractId`/historial). Si el delete del viejo falla tras crear el nuevo, el viejo sobrevive (no se pierde el secret) y se reporta para reintento.

**Frontend (page nueva, `ui-ux-pro-max` obligatorio):**

4. **Tab "PPPoE"** agregado al array `TABS` de `GestionRedPage` (aditivo) + componente `PppoeManagementTab`.
5. **Tabla paginada** (reusa `useAllPppoe`, `Pagination`, `DataTable`, `StatusBadge`): columnas Username · Cliente (o ⚠ huérfano) · Plan · Estado · IP · NAS · Acciones. Filtros: search (debounced) + **select de NAS** (`useNasServers`) + status. Pasa `includeUnassigned: true`.
6. **Acciones por fila** (reusan hooks `usePppoe`): editar (password/plan/IP/status), **cambiar username** (modal con warning "esto recrea el secret y desconecta al cliente"), mover NAS, suspender/reactivar, baja, **revelar password on-demand** (`usePppoeCredentials`, botón "ojo").
7. **Botón "Crear PPPoE"** en el header del tab → modal: NAS (req) + plan (req) + username/password (req) + IP (fixed/pool) + **cliente/contrato OPCIONAL**.

### Out of Scope

- **Tocar el orchestrator** (Python/AAA prod). Todo el CRUD del HA YA existe (`POST /users`, `/password`, `/plan`, `/framed-ip`, `/mac`, `/suspend`, `/reactivate`, `DELETE /users`). No se agrega nada del lado del RADIUS HA.
- **Tocar `InternetPanel`, `InternetServicesPage`, ni el tab "Sesiones activas".** Cero cambios en lo que ya está en prod.
- **Cortes masivos / enforcement bulk** — ya existe la page de Cortes PPPoE (`pppoe.cut`). Esta page es de gestión individual; el enforce por fila (reduce/block/restore) puede sumarse como follow-up, no en V1.
- **Listar en vivo del orchestrator** — descartado: `GET /users` no pagina ni filtra por NAS (el NAS vive en el espejo `PppoeService.nasId`). La lista sale del espejo DB; las escrituras impactan el HA.

## Capabilities

### New Capabilities
- **PPPoE Network Management (FE)**: tab operativo en Gestión de Red para listar/filtrar/operar todos los PPPoE del RADIUS HA.

### Modified Capabilities
- **PPPoE Management (BE)**: el listado global soporta incluir huérfanos (`includeUnassigned`); create acepta contrato opcional; nuevo flujo de recrear username.

## Approach

1. **(test primero, BE)** Tests de `listAllPaginated` con `includeUnassigned` (incluye/excluye huérfanos, default sin romper), `CreatePppoeStandalone` (con y sin contrato), `RenamePppoeUsername` (happy path + delete-old-falla = viejo sobrevive + nuevo-username-duplicado rechaza).
2. **(green, BE)** Implementar el flag + use cases + rutas, enrutando al orchestrator vía `RadiusOrchestratorGateway`.
3. **(test primero, FE)** Tests Vitest del tab: render tabla, filtro NAS round-trip, paginación, acciones llaman a los hooks correctos, reveal password lazy, warning del rename.
4. **(green, FE)** `PppoeManagementTab` + modales, reusando hooks/componentes existentes. Checklist `ui-ux-pro-max`.

## Affected Areas

| Área | Impacto |
|------|---------|
| **BE** `application/use-cases/ListAllPppoeServices.ts` | Modified — param `includeUnassigned` |
| **BE** `infrastructure/adapters/prisma/PrismaPppoeServiceRepository.ts` (+ in-memory) | Modified — `listAllPaginated` respeta el flag |
| **BE** `application/use-cases/CreatePppoeStandalone.ts` (o extensión) | New/Modified — contrato opcional |
| **BE** `application/use-cases/RenamePppoeUsername.ts` | New — recrear username |
| **BE** `infrastructure/http/routes/pppoe.routes.ts` | Modified — `POST /api/pppoe`, `POST /api/pppoe/:id/rename`, param `includeUnassigned` en `GET /api/pppoe` |
| **FE** `pages/networking/GestionRedPage.tsx` | Modified (aditivo) — tab "PPPoE" en `TABS` + render |
| **FE** `pages/networking/PppoeManagementTab.tsx` (+ modales + `.module.css`) | New |
| **FE** `hooks/usePppoe.ts` / `useInternetServices.ts` / `api/pppoe.api.ts` | Modified — `includeUnassigned`, create standalone, rename |
| **FE** `__tests__/networking/PppoeManagementTab.test.tsx` | New |

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| **Recrear username deja al cliente sin secret** | Media | create-then-delete (nunca delete-first); si el create falla, no se toca el viejo; si el delete del viejo falla, el viejo sobrevive y se reporta. Warning explícito en la UI: "recrea el secret, el CPE debe reconfigurarse". |
| `includeUnassigned` filtra mal y la page vieja empieza a mostrar huérfanos | Baja | Default `false`; test que pinea el comportamiento viejo de `InternetServicesPage`. |
| Crear huérfanos a propósito ensucia la data | Baja | Es decisión del usuario (contrato opcional); el ⚠ los marca y se pueden asociar después (`/associate` ya existe). |
| Leak de password en la lista | Baja | El listado sigue sin password (DTO lo dropea); reveal solo on-demand vía `/credentials` (gate `pppoe.manage`). |
| Tocar `GestionRedPage` rompe un tab viejo | Baja | Cambio puramente aditivo (1 entrada al array + 1 render condicional); suite FE completa + review. |

## Rollback

- **BE**: aditivo, sin migración de schema (el flag es un param; los use cases nuevos no alteran tablas). Rollback = `git revert` del commit BE.
- **FE**: page nueva + tab aditivo. Rollback = `git revert` del commit FE. El tab desaparece, lo viejo intacto.

## Dependencies

- `HttpRadiusOrchestratorGateway` + `RadiusOrchestratorGateway` port (CRUD HA 1:1) — ya existen.
- `PrismaPppoeServiceRepository.listAllPaginated`, `UpdatePppoeService`, rutas `move`/`pin-ip`/`unpin-ip`/`credentials` — ya existen.
- FE: `useAllPppoe`, `usePppoe` (CRUD), `useNasServers`, `usePlans`, `usePppoeCredentials`, `Pagination`, `DataTable`, `StatusBadge` — ya existen.
- Permisos `pppoe.read` / `pppoe.manage` — ya en el `/me` (los usan las pages viejas).
- Skill `ui-ux-pro-max` para toda la UI.

## Success Criteria

- [ ] Tab "PPPoE" visible en Gestión de Red (gate `pppoe.read`), sin afectar los tabs existentes.
- [ ] La tabla lista TODOS los PPPoE (con y sin contrato); huérfanos con ⚠; paginada server-side.
- [ ] Filtro por NAS (select), search y status funcionan round-trip.
- [ ] Crear PPPoE con NAS+plan+credenciales y **contrato opcional** → impacta el HA + espejo.
- [ ] Cambiar password/plan/IP/status por fila → directo al HA.
- [ ] Cambiar username (recrear) con warning; si el create falla el viejo queda intacto.
- [ ] Mover NAS, suspender/reactivar, baja por fila.
- [ ] Revelar password on-demand (gate `pppoe.manage`), nunca en el listado.
- [ ] `includeUnassigned=false` (default) deja `InternetServicesPage` idéntica (test que lo pinea).
- [ ] Gates verdes: suite BE + `tsc`; suite FE + `tsc`; checklist `ui-ux-pro-max`; review adversarial CLEAN.
