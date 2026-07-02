# Design: Rediseño Sesiones activas + Pools IP (filtros + paginado server-side)

## Contexto (estado verificado, file:line)

### Sesiones activas — flujo HOY

```
FE useRadiusSessions()  →  GET /api/radius/sessions
  ↓ (radius.routes.ts:77-80, gate network.read)
ListRadiusSessions.execute()  (sin params, ListRadiusSessions.ts:25)
  ↓ repo.listSessions()  →  OrchestratorRadiusSessionRepository.fetchAll()
     (pagina el orchestrator de a 100, junta TODO en memoria — ~3k objetos)
  ↓ pppoeRepo.findByUsernames(usernames)  (BATCH, 1 query, NO N+1)
  ↓ map: enriquece contractId/clientId/customerName por username
  →  RadiusSession[]  (array completo, sin filtrar, sin paginar)
FE  →  renderiza las ~2949 filas de una, agrupadas por NAS display-side
       badge del tab = sessions.length  (GestionRedPage.tsx:747)
```

**Verdad de los datos (fuente real `OrchestratorRadiusSessionRepository`, entity `radiusSessions.ts`):**

| Campo `RadiusSession` | Origen real (orchestrator) | Nota crítica |
|-----------------------|----------------------------|--------------|
| `id`, `sessionId` | `sessionId` del orchestrator | mismo valor; sirve para el DELETE |
| `username` | `username` | clave del cruce a contrato |
| `nasId` | **`nasIp`** | ⚠️ NO es un id de NAS; es la IP. `nasId === nasName === nasIp`. |
| `nasName` | **`nasIp`** | idem |
| `ipAddress` | `framedIp` | puede ser `null` |
| `macAddress` | `callerId` (caller-id / MAC del CPE) | puede ser `null` |
| `status` | **hardcodeado `'active'`** | ⚠️ la fuente real NUNCA emite `'idle'` (`OrchestratorRadiusSessionRepository:94`). El in-memory SÍ. |
| `downloadMbps` / `uploadMbps` | **`0`** | el orchestrator no expone tasa instantánea (`:92-93`) |
| `contractId`/`clientId`/`customerName` | cruce por username (use case) | `null` = PPPoE sin contrato → el FE muestra ⚠ |

### Sesiones — consumidores actuales del contrato (a preservar)

- FE: `useRadiusSessions` (`radius.api.ts` → `GET /api/radius/sessions`), consume `RadiusSession[]`; badge = `.length`.
- Test: `radius.routes.test.ts:151-156` → `expect(Array.isArray(res.body)).toBe(true)` + `toHaveLength(15)`.
- Test: `RadiusSessionUseCases.test.ts`, `listRadiusSessions.terminated.test.ts` → `execute()` sin params devuelve array.

### Pools — flujo HOY

```
FE useIpPools()  →  GET /api/ip-pools  (ipNetwork.routes.ts:67, gate network.read)
  ↓ ListIpPools.execute()  (ListIpPools.ts:27-44)
  →  IpPool[]  con assignedCount|totalCount (assignedCount null = NAS no respondió)
FE  →  filtra por texto FE (name/rangeStart/rangeEnd, SIN debounce),
       agrupa por nasId display-side, NoData(—) + UsageBar(semáforo azul/ámbar/rojo)
```

**`ipKind` (`cgnat`|`public`|`null`)** existe en el entity `IpPool` (`network.ts:36`) y `ListIpPools` lo arrastra vía `...pool`, PERO el **tipo del FE (`ipnext-frontend/src/types/network.ts`) NO lo declara** → hoy el FE no lo consume. Para el filtro cgnat/public hay que asegurarlo en el contrato (ver D6).

---

## Decisión 1 (LA CLAVE) — `/api/radius/sessions`: params opcionales con **envelope condicional back-compat**

**Elegido:** extender el endpoint existente `GET /api/radius/sessions` con params **opcionales**. El shape de la respuesta depende de si vienen params:

- **Request SIN ningún param** → responde el **array legacy `RadiusSession[]`** (idéntico a hoy).
- **Request CON al menos un param** (`search`|`nasId`|`status`|`page`|`limit`) → responde el **envelope** `{ data, total, page, limit, hasNext, stats }`.

### Por qué esta opción y no las alternativas

| Opción | Veredicto | Razón |
|--------|-----------|-------|
| **A. Envelope condicional back-compat** (elegida) | ✅ | Cero ventana de ruptura: el BE se puede deployar ANTES del FE (push=prod por repo) sin romper el FE viejo (que llama sin params → sigue recibiendo array). El FE nuevo llama con `page/limit` → recibe envelope. Preserva TODOS los tests `Array.isArray`. Reversible en cualquier orden. |
| **B. Envelope SIEMPRE (romper el array)** | ❌ | Obliga a deploy BE+FE atómico serial estricto; entre el push del BE y el del FE, el FE viejo recibe `{data:[...]}` y hace `.map` sobre un objeto → tab roto en prod. Rompe los tests `Array.isArray`. Lección #28: contrato coordinado — pero acá el back-compat es barato, así que se prefiere. |
| **C. Endpoint nuevo `/api/sessions`** | ❌ | Duplica ruta + wiring + use case; el `/api/sessions` del pedido **no existe** (el real es `/api/radius/sessions`); deja el viejo endpoint como deuda. Sobre-ingeniería. |

**Consecuencia:** el deploy es **BE primero, FE después**, pero sin acoplamiento duro — el envelope condicional hace cada repo tolerante al otro. Esto respeta la lección #28 (cambio de contrato coordinado) SIN el costo de un deploy atómico frágil. El FE nuevo SIEMPRE manda `page`/`limit` (aunque sea la página 1) → siempre recibe envelope → nunca depende del modo array.

> **Nota de implementación:** el "modo array" es solo para back-compat de consumidores viejos. El FE rediseñado opera 100% en modo envelope. Una vez migrado todo consumidor, el modo array puede deprecarse en un change futuro (fuera de alcance).

## Decisión 2 — Filtrado + paginado EN MEMORIA en el use case (no en el orchestrator, no en Prisma)

El use case sigue trayendo TODO del orchestrator (`repo.listSessions()`) — ese snapshot de ~3k objetos **ya se materializa hoy**, no es costo nuevo. Sobre el array enriquecido en memoria:

1. **Enriquecer** (como hoy: `findByUsernames` batch → contractId/clientId/customerName).
2. **Filtrar** por `search` / `nasId` / `status` (predicados en memoria).
3. **Calcular `stats`** sobre el set filtrado-por-search/nasId (ignorando `status`).
4. **Paginar** (`slice((page-1)*limit, ...)`), con `limit` cap (default 50, max 200 — mismo cap que los otros use cases).

**Por qué en memoria y no empujar al orchestrator:** el orchestrator `GET /sessions?offset&limit` NO soporta filtros por search/customerName (el `customerName` se resuelve en Prominense por el cruce a contrato — el orchestrator ni lo conoce). Filtrar en el orchestrator dejaría afuera el filtro por cliente. Además `RadiusSessionRepository.listSessions()` (el port) no expone paginación — cambiar el port para paginar el orchestrator NO ayuda (el filtro por customerName exige tener el cruce ya hecho). El filtrado en memoria post-enriquecimiento es la única capa que ve TODOS los campos filtrables. Es el mismo patrón que `ListNe8000PppoeAudit.executeWithOnlineFilter` (carga sin paginar → enriquece → filtra derivado → pagina).

**Orden estable:** paginar exige orden determinístico cross-página. Se ordena por `username` ASC (o `startedAt` DESC) ANTES de paginar, de forma estable, para que la página N sea consistente entre requests.

## Decisión 3 — `stats` en el envelope (KPIs de estado), patrón `countsByReason`

El envelope incluye `stats: { total, active, idle }` calculado sobre el set filtrado por `search`+`nasId` **ignorando el filtro `status`** — así los KPIs por estado muestran el desglose completo aunque el usuario haya seleccionado un estado (idéntico a `countsByReason` en `ListRadiusAuthFailures.ts:60-69`, que ignora el filtro `reason` para los chips).

- `total` = filas que matchean search+nasId (sin filtrar por status). Este es el número del **badge del tab**.
- `active` / `idle` = desglose por status dentro de ese set.

Esto resuelve el problema del badge "2949": el FE lee `stats.total` (o `total` del envelope cuando no hay filtro de status; se unifican — ver spec). Sin `stats`, el FE paginado no podría mostrar el count total.

## Decisión 4 — El filtro `status` se implementa aunque en prod hoy solo haya `active`

La fuente real emite siempre `status='active'`. El filtro `status='idle'` es **correcto pero devolverá vacío en prod** hasta que la fuente exponga idle. Se implementa igual porque:
- El contrato del entity declara `status: 'active' | 'idle'` — el filtro debe honrarlo.
- El in-memory SÍ emite `idle` (`InMemoryRadiusSessionRepository:34`, filas i>12) → los **tests de seam del filtro status son deterministas y verdes**.
- El día que la fuente emita idle, el filtro ya funciona sin tocar nada.

No es un bug del redesign; es una limitación de la fuente, documentada. **No revertir por "idle da vacío".**

## Decisión 5 — Pools: rediseño **FE-only**, sin paginado server-side (justificación)

~30 pools. Server-side paging acá:
- No reduce payload de forma significativa (30 filas es trivial).
- Agrega complejidad (envelope, params, orden cross-página) sin beneficio.
- Rompería el filtrado/agrupado/orden que es más natural en el cliente con el dataset completo en mano.

**Decisión: pools se queda con `GET /ip-pools` → array plano completo.** Todo el redesign de pools (filtros, colapsables, KPIs, orden) es **presentación en el FE**. Único toque de BE posible: exponer `ipKind` (D6).

### KPIs de pools null-safe (regla dura, heredada de `gestion-red-radius-counters`)

Los KPIs de cabecera (IPs totales / asignadas / libres) se agregan **excluyendo** los pools con `assignedCount === null`:
- `totalAsignadas = Σ assignedCount` **solo sobre pools con assignedCount !== null**.
- `totalLibres = Σ (totalCount - assignedCount)` idem.
- `poolsSinDato = count(assignedCount === null)` → se muestra como badge "N sin dato".
- `totalIps = Σ totalCount` (sí incluye todos: totalCount nunca es null).

NUNCA `assignedCount ?? 0` en un agregado. `null` no es 0. El `UsageBar` ya renderiza `NoData` cuando `used == null` — se preserva.

### Orden por uso descendente dentro del grupo

Dentro de cada grupo (router), ordenar por `% uso = assignedCount / totalCount` **descendente**. Los pools con `assignedCount === null` van **al final** del grupo (no tienen % calculable) — NO se les asigna % 0 para no falsear el orden.

## Decisión 6 — `ipKind` en el contrato de pools (aditivo, verificar antes de tocar)

`ListIpPools.execute()` devuelve `{ ...pool, totalCount, assignedCount }`, y `pool` incluye `ipKind` del entity. La ruta `GET /ip-pools` hace `res.json(pools)` sin mapper explícito → **`ipKind` probablemente YA viaja en el JSON**, pero el **tipo del FE no lo declara** (`ipnext-frontend/src/types/network.ts`).

**Acción:** (1) verificar en un test de la ruta que `ipKind` está en el body; (2) agregar `ipKind: 'cgnat' | 'public' | null` al tipo `IpPool` del FE. Si por alguna razón el BE lo estuviera omitiendo, exponerlo (aditivo, read-only). Si el filtro ipKind no fuera viable a tiempo, se difiere sin bloquear el resto del redesign de pools.

## Decisión 7 — FE: debounce del search (300ms) reutilizando el patrón existente

No hay `useDebounce` centralizado, pero existe `useSearch(debounceMs=300)` y el patrón useRef (`FilterBar`, `GeoLocationEditor`). El search de sesiones (que dispara un `GET` server-side) **debe** ir debounced 300ms para no pegar un request por tecla. El filtro de texto de pools (FE puro, sin request) también se debouncea por consistencia de UX, aunque sea barato.

**Reset de página:** al cambiar cualquier filtro (search/nasId/status), la paginación se resetea a `page=1` (patrón estándar; el tab de auditoría ya lo hace).

## Decisión 8bis (S2, post-review adversarial) — Normalización de separadores de MAC: descartada

Se evaluó normalizar el separador de `macAddress` (`:` vs `-`, mayúsculas/minúsculas) antes de
comparar contra `search`, para que `search=aabbcc` matchee `AA:BB:CC:...` sin que el usuario
tipee los separadores exactos. **Se descarta**: el `search` de sesiones es un **substring puro**
sobre `macAddress` tal cual llega de la fuente. El orchestrator emite `callerId` con un formato
consistente `AA:BB:CC:DD:EE:FF` (siempre `:` como separador, siempre mayúsculas) — no hay
variabilidad real que justificar la normalización. Agregarla acá resolvería un problema que no
existe en la fuente de datos real, a costa de una transformación extra en el hot path de cada
request paginado. Si en el futuro el orchestrator cambia de formato, se revisita.

## Decisión 8 — Hexagonal / DIP

- `ListRadiusSessions` sigue dependiendo de los **ports** `RadiusSessionRepository` + `PppoeServiceRepository`. **No se agregan métodos al port** (el filtrado es en memoria post-enriquecimiento). El use case NO importa nada de `infrastructure/` ni Prisma.
- El DTO paginado (`PaginatedRadiusSessionsDto`) vive en `application/dto/` (como `radius-event.dto.ts`).
- Tests TDD con `InMemoryRadiusSessionRepository` + `InMemoryPppoeServiceRepository` (o `InMemoryRadiusOrchestratorGateway` para el seam de ruta) — **NO mockear el use case** (lección #28). Cada filtro/param tiene su test de seam: ruta real → use case real → repos in-memory.

## Contrato del envelope de sesiones (campo por campo — lección W6)

```ts
// application/dto/radius-session.dto.ts (nuevo)
export interface RadiusSessionDto {
  // 1:1 con RadiusSession (entity) — se mapea explícito, NO se devuelve la entity cruda:
  id: string;
  sessionId: string;
  username: string;
  clientName: string;
  nasId: string | null;         // = nasIp en la fuente real
  nasName: string | null;       // = nasIp en la fuente real
  ipAddress: string | null;     // framedIp
  macAddress: string | null;    // callerId
  startedAt: string;            // ISO 8601
  duration: number;             // segundos
  downloadBytes: number;
  uploadBytes: number;
  downloadMbps: number;         // 0 en la fuente real
  uploadMbps: number;           // 0 en la fuente real
  status: 'active' | 'idle';    // 'active' siempre en la fuente real
  contractId: string | null;
  clientId: string | null;
  customerName: string | null;
}

export interface RadiusSessionsStats {
  total: number;   // filas que matchean search+nasId (ignora status) — el BADGE del tab
  active: number;
  idle: number;
}

export interface PaginatedRadiusSessionsDto {
  data: RadiusSessionDto[];
  total: number;    // = stats.total cuando no hay filtro status; = filas matcheadas por TODOS los filtros
  page: number;
  limit: number;
  hasNext: boolean; // page * limit < total
  stats: RadiusSessionsStats;
}
```

> **`total` vs `stats.total`:** `total` = filas de la respuesta paginada (matchean TODOS los filtros incl. status) → gobierna `hasNext` y `totalPages`. `stats.total` = filas que matchean search+nasId ignorando status → gobierna el badge del tab y los KPIs. Se exponen ambos para que el FE no tenga que recalcular.

## Flujo — sesiones con filtros + paginado (sequence)

```
FE → GET /api/radius/sessions?search=perez&nasId=10.75.0.30&page=1&limit=50
  ↓ radius.routes.ts: valida page/limit (parseIntPositive), status ∈ {active,idle}
  ↓ hay params → ListRadiusSessions.execute({ search, nasId, page, limit })
      sessions = repo.listSessions()               // todo el snapshot (como hoy)
      enriched = enrich(sessions, pppoeRepo)        // batch por username (como hoy)
      bySearchNas = enriched.filter(search ∧ nasId)
      stats = { total: bySearchNas.length,
                active: count(active), idle: count(idle) }
      final = status ? bySearchNas.filter(status) : bySearchNas
      ordered = stableSort(final, username ASC)
      page = ordered.slice((p-1)*limit, p*limit)
      → { data: page.map(toDto), total: final.length, page, limit,
          hasNext: p*limit < final.length, stats }
  ↓ res.json(envelope)
FE → tabla paginada (Pagination) + KPIs de stats + badge = stats.total
```

## Wiring (verificado contra el diseño)

- `ListRadiusSessions` YA está cableado en `app.ts:1232` (`new ListRadiusSessions(radiusRepo, new PrismaPppoeServiceRepository())`). El cambio es a la **firma de `execute`**, no al wiring → el wiring no cambia salvo confirmar que la ruta le pasa los params.
- `GET /sessions` montado en `app.ts:1812` bajo `/api/radius` → URL real `/api/radius/sessions`.
- `GET /ip-pools` montado en `app.ts:1786` bajo `/api` → URL real `/api/ip-pools`.
- **Composition test** (anti "feature muerta"): la ruta con params responde envelope real vía el use case real con repos in-memory.

## Agujeros de permisos (revisado)

Ambos endpoints (`/api/radius/sessions`, `/api/ip-pools`) están gated `network.read` (verificado `radius.routes.ts:72`, `ipNetwork.routes.ts:43`). Los nuevos params no exponen data nueva sensible (misma data, filtrada/paginada). **Sin permisos nuevos.** No se detectó agujero.

## Testing (TDD estricto, seam completo por param)

| Test | Nivel | Qué verifica |
|------|-------|--------------|
| `execute()` sin params → array | use case | back-compat |
| `execute({page,limit})` → envelope shape | use case | `{data,total,page,limit,hasNext,stats}` |
| `search` matchea username/customerName/ipAddress/macAddress | use case | 4 campos, case-insensitive, substring |
| `nasId` filtra | use case | por nasId/nasIp |
| `status` filtra (in-memory tiene idle) | use case | active vs idle |
| combinación search+nasId+status+page | use case | total/página correctos, orden estable |
| `stats` ignora status | use case | total = search+nasId; active/idle desglose |
| ruta sin params → 200 array | seam ruta+uc real | `Array.isArray` |
| ruta con page/limit → 200 envelope | seam ruta+uc real | body.data array, body.total number |
| ruta `page=0`/`limit=-1`/`status=foo` → 400 | ruta | validación (parseIntPositive, enum) |
| ruta gate network.read → 401/403 | ruta | RBAC preservado |
| `/ip-pools` body incluye `ipKind` | seam ruta | contrato de pools |
| KPIs pools excluyen assignedCount null | FE (Vitest) | agregado null-safe + "N sin dato" |

## Review adversarial (2 revisores calibrados)

- **Revisor 1 — Contrato / Paginación (BE):** envelope condicional back-compat correcto; `total` vs `stats.total`; orden estable cross-página; validación de params; tests `Array.isArray` intactos; DIP (use case no importa infra); wiring vivo.
- **Revisor 2 — FE / Estado de filtros:** debounce + reset de page; el badge lee `stats.total`; KPIs de pools null-safe (no `?? 0`); NoData/UsageBar preservados; orden por uso con null al final; accesibilidad (contraste, touch 44px, focus, aria NoData); ui-ux-pro-max aplicada.
