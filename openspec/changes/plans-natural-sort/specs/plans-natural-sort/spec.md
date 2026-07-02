# Capability: plans-natural-sort

`GET /api/plans` devuelve la lista de planes en **orden natural por código** (numeric-aware, case-insensitive), con desempate por `name` y desempate final por `id`. El sort lo aplica el use case `ListPlans` después de consultar el repositorio, de modo que todos los consumidores del endpoint reciban el orden correcto sin cambios en el FE ni en el contrato de la API.

> **(decisión post-review 2026-07-01: el catálogo muestra code; los fixtures code===name enmascaraban el mismatch)** — la clave de orden es `code` (lo que el usuario ve, ej. `IP-Air-20-10`), NO `name`. Desempates: `name` (mismo compare natural) → `id` (orden total determinista). Todas las claves llevan guard null/undefined (`?? ''`). El sort es inmutable (`[...plans].sort(...)`) y vive SOLO en `ListPlans`; el in-memory no ordena.

## MODIFIED Requirements

### Requirement: Orden natural por código en la lista de planes

`ListPlans.execute()` SHALL devolver los planes ordenados por `code` con sort natural numeric-aware: las secuencias de dígitos se comparan como números, no como strings. El orden SHALL ser case-insensitive. Ante empate de `code`, SHALL desempatar por `name` (mismo compare natural); ante empate de `code` y `name`, SHALL desempatar por `id` — el orden resultante es TOTAL y determinista. Un `code` o `name` null/undefined SHALL tratarse como string vacío (nunca lanzar TypeError; el plan queda en posición determinista al principio). El sort SHALL ser inmutable: el array devuelto por el repositorio no se muta.

**Referencia de implementación:** `(a.code ?? '').localeCompare(b.code ?? '', undefined, { numeric: true, sensitivity: 'base' })`, con desempates `name` → `id` (ver `src/application/utils/naturalSort.ts`).

#### Scenario: planes con segmentos numéricos distintos se ordenan por valor numérico

- **GIVEN** que el repositorio contiene los planes con code `IP-Air-100-30` e `IP-Air-20-10` (en cualquier orden de inserción)
- **WHEN** se llama `ListPlans.execute()`
- **THEN** `IP-Air-20-10` aparece antes que `IP-Air-100-30` en el array resultante

#### Scenario: la clave es code, no name

- **GIVEN** que el repositorio contiene un plan con code `IP-Air-100-30` y name `A-primero-por-name`, y otro con code `IP-Air-20-10` y name `Z-ultimo-por-name`
- **WHEN** se llama `ListPlans.execute()`
- **THEN** el plan con code `IP-Air-20-10` aparece primero (el orden lo decide `code`, no `name`)

#### Scenario: secuencia completa de planes Air en orden ascendente

- **GIVEN** que el repositorio contiene los planes con codes `IP-Air-100-100`, `IP-Air-20-10`, `IP-Air-80-30`, `IP-Air-50-15`, `IP-Air-100-30`, `IP-Air-50-50`, `IP-Air-80-80` insertados en orden aleatorio
- **WHEN** se llama `ListPlans.execute()`
- **THEN** el array resultante tiene exactamente este orden de codes: `IP-Air-20-10`, `IP-Air-50-15`, `IP-Air-50-50`, `IP-Air-80-30`, `IP-Air-80-80`, `IP-Air-100-30`, `IP-Air-100-100`

#### Scenario: lista vacía sigue siendo vacía

- **GIVEN** que el repositorio no contiene planes
- **WHEN** se llama `ListPlans.execute()`
- **THEN** el resultado es un array vacío (sin error)

#### Scenario: un solo plan devuelve lista de un elemento

- **GIVEN** que el repositorio contiene un solo plan con code `IP-Air-50-15`
- **WHEN** se llama `ListPlans.execute()`
- **THEN** el resultado es un array de un elemento con ese plan

#### Scenario: el sort es case-insensitive

- **GIVEN** que el repositorio contiene los planes con codes `ip-air-20-10` e `IP-Air-100-30`
- **WHEN** se llama `ListPlans.execute()`
- **THEN** `ip-air-20-10` aparece antes que `IP-Air-100-30` (20 < 100, independientemente de la capitalización)

#### Scenario: codes no-numéricos se ordenan lexicográficamente

- **GIVEN** que el repositorio contiene los planes con codes `IP-BAJA`, `IP-Air-20-10`, `IP-REDUCCION`, `IP-Alta-50-20`
- **WHEN** se llama `ListPlans.execute()`
- **THEN** el orden resultante respeta el sort natural: `IP-Air-20-10` antes que `IP-Alta-50-20` (A < Al por localeCompare), y `IP-BAJA` e `IP-REDUCCION` en posición determinista (sin crash ni panic)

#### Scenario: planes con el mismo name tienen orden relativo determinista por code

- **GIVEN** que el repositorio contiene dos planes con `name` idéntico y codes `CODE-A` y `CODE-B` (insertados en orden inverso)
- **WHEN** se llama `ListPlans.execute()`
- **THEN** el resultado incluye ambos planes con `CODE-A` antes que `CODE-B` (orden RELATIVO afirmado, no solo el count)

#### Scenario: planes con code y name idénticos desempatan por id

- **GIVEN** que el repositorio contiene dos planes con `code` y `name` idénticos e ids `id-1` e `id-2`
- **WHEN** se llama `ListPlans.execute()`
- **THEN** `id-1` aparece antes que `id-2` (orden total determinista)

#### Scenario: un code null/undefined no crashea

- **GIVEN** que el repositorio contiene un plan con `code` undefined y otro con code `IP-Air-20-10`
- **WHEN** se llama `ListPlans.execute()`
- **THEN** no se lanza ningún error y el plan sin code aparece al principio (string vacío compara primero — posición determinista)

#### Scenario: el array del repositorio no se muta

- **GIVEN** que el repositorio devuelve un array de planes en orden no natural
- **WHEN** se llama `ListPlans.execute()`
- **THEN** el resultado está ordenado pero el array original del repositorio conserva su orden (sort inmutable sobre una copia)

### Requirement: `PlanRepository.list()` no garantiza orden — el sort vive SOLO en `ListPlans`

El port `PlanRepository.list()` SHALL documentar (JSDoc) que el orden NO está garantizado. `InMemoryPlanRepository.list()` SHALL devolver los planes en orden de inserción (espejo de Prisma, que devuelve el orden de la DB), SIN sort propio — así los tests de `ListPlans` prueban al use case y no al adapter.

> (decisión post-review 2026-07-01: se revirtió el sort que la primera iteración había agregado al in-memory)

#### Scenario: el in-memory devuelve orden de inserción

- **GIVEN** que se usa `InMemoryPlanRepository` con planes insertados en orden inverso al natural
- **WHEN** se llama `list()`
- **THEN** los planes llegan en orden de inserción (NO en orden natural) — el orden del catálogo lo aplica `ListPlans`

### Requirement: el contrato de `GET /api/plans` no cambia

El endpoint SHALL seguir devolviendo el mismo `PlanDto` con los mismos campos (`id`, `code`, `name`, `category`, `downloadKbps`, `uploadKbps`, `status`, `rateLimit`, `createdAt`, `updatedAt`). Solo cambia el orden de los elementos del array. Ningún campo es añadido, eliminado ni renombrado.

#### Scenario: la ruta devuelve planes ordenados naturalmente

- **GIVEN** que la base de datos contiene planes con codes `IP-Air-100-30` e `IP-Air-20-10` (names deliberadamente contrarios al orden de code)
- **WHEN** un usuario con permiso `plan.read` hace `GET /api/plans`
- **THEN** la respuesta es 200 con un array donde `IP-Air-20-10` aparece antes que `IP-Air-100-30`, y cada elemento tiene el campo `rateLimit` calculado correctamente

## Non-functional Requirements

- **Sin migración de datos:** el cambio es puramente de comportamiento en la capa application. No requiere `prisma migrate`.
- **Sin cambio de schema:** el modelo `Plan` no cambia.
- **Compatibilidad regresiva:** los clientes del endpoint que no dependan del orden (o que ya asumían un orden determinado) no se ven afectados negativamente.
- **DIP preservado:** la capa `application/` no importa nada de `infrastructure/`. El sort opera sobre `Plan[]` (dominio puro).
