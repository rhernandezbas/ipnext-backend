# Proposal: Orden natural de planes por código (numeric-aware)

> **(decisión post-review 2026-07-01: el catálogo muestra code; los fixtures code===name enmascaraban el mismatch)** — la clave de orden es `code` con desempate `name` → `id`, guard de null en todas las claves, sort inmutable SOLO en `ListPlans`, e in-memory sin sort propio.

## Intent

Que la lista de planes devuelta por `GET /api/plans` llegue al cliente en **orden natural por código** (numeric-aware), de modo que `IP-Air-20-10` preceda a `IP-Air-50-15` y a `IP-Air-100-30`, independientemente del orden en que fueron insertados en la base de datos. El pedido del usuario es sobre el código visible (`IP-Air-20-10`) y el catálogo FE muestra `plan.code`.

## Why

- **El problema observable:** la ruta `GET /api/plans` delega en `PrismaPlanRepository.list()` que hace un `findMany()` sin `orderBy`. El orden que devuelve Prisma depende de la implementación interna del motor (generalmente orden de inserción o de heap). IP-Air-20-10 puede aparecer al final cuando debería ser el primero de su categoría.
- **Impacto en el FE:** el frontend agrupa los planes por categoría (`Air`, `Alta`, `Corte`) pero confía en que el BE le entrega los planes ya ordenados dentro de cada grupo. Hoy el orden dentro de cada grupo es no determinista.
- **Todos los consumidores afectados:** la tabla `PlansPage` y los dropdowns de "Cargar PPPoE" y "Editar servicio" consumen el mismo endpoint. Corregir el orden en el BE impacta a todos sin tocar el FE.
- **Esfuerzo mínimo, impacto alto:** el cambio es una sola línea en el use case más el comparator, sin migración de datos ni cambio de contrato de API.

## Scope

### In Scope

- Sort natural por `code` (numeric-aware, case-insensitive) en el use case `ListPlans`, con desempate por `name` y desempate final por `id` (orden total determinista). Guard de null/undefined en todas las claves. Sort inmutable (`[...plans].sort(...)`).
- Documentar en el port `PlanRepository.list()` (JSDoc) que el orden NO está garantizado. `InMemoryPlanRepository.list()` devuelve orden de inserción, SIN sort propio (espejo de Prisma, que devuelve orden de DB).
- Tests TDD del comparator y del comportamiento end-to-end a través de `ListPlans` + in-memory repo, más test de ruta HTTP (`GET /api/plans` con supertest).

### Out of Scope

- Cambios en el FE (el FE ya agrupa por categoría; el orden rellenado por el BE es suficiente).
- `orderBy` en `PrismaPlanRepository` — se evita deliberadamente (ver decisión de diseño).
- Cambios en el contrato de la API (`PlanDto`, rutas, autenticación).
- Paginación o filtrado de la lista de planes.
- Otros repositorios o use cases.

## Capabilities

### Modified Capabilities

- `plan-listing`: `GET /api/plans` pasa de devolver planes en orden no determinista a devolver **orden natural por código** (numeric-aware, case-insensitive), desempate `name` → `id`. El contrato de la respuesta no cambia — solo el orden de los elementos del array.

## Approach

1. **Implementar el comparator** de orden natural en `src/application/utils/naturalSort.ts` usando `String.prototype.localeCompare` con `{ numeric: true, sensitivity: 'base' }` sobre `code`, con guard de null (`?? ''`) y desempates `name` → `id`. `ListPlans.execute()` lo aplica sobre una COPIA del array (`[...plans].sort(...)`).
2. **`InMemoryPlanRepository.list()` NO ordena** — devuelve orden de inserción (como Prisma devuelve orden de DB). El port `PlanRepository.list()` documenta (JSDoc) que el orden no está garantizado. (decisión post-review 2026-07-01: se revirtió el sort del in-memory de la primera iteración.)
3. **TDD:** primero los tests del use case con el in-memory repo (fixtures con `code !== name` para no enmascarar la clave), luego el código (red → green → refactor). Test de ruta HTTP con supertest.
4. **Gate de calidad:** `npm test` verde + `tsc --noEmit` limpio. Un revisor.

## Affected Areas

| Área | Impacto | Descripción |
|------|---------|-------------|
| `src/application/utils/naturalSort.ts` | New | Comparator natural null-safe: `code` → `name` → `id` |
| `src/application/use-cases/ListPlans.ts` | Modified | Aplica sort natural por `code` (inmutable) sobre el resultado del repo |
| `src/domain/ports/PlanRepository.ts` | Modified | JSDoc en `list()`: el orden NO está garantizado por el port |
| `src/__tests__/application/ListPlans.sort.test.ts` | New | Tests TDD del sort natural (use case + in-memory + stub) |
| `src/__tests__/infrastructure/plan.routes.test.ts` | Modified | Test de ruta: `GET /api/plans` responde ordenado por code |

> No hay cambios en `PrismaPlanRepository`, `plan.dto.ts`, `plan.routes.ts`, `plan.ts` (entidad), ni en ninguna otra capa. No hay migración de base de datos. `InMemoryPlanRepository` queda SIN sort (la primera iteración se lo había agregado; post-review se revirtió).

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| `localeCompare` no disponible en el runtime del contenedor | Muy Baja | Node.js incluye ICU por defecto; `localeCompare` con `{numeric:true}` es estándar ES2015 |
| Regresión en tests existentes de `plan.routes.test.ts` que no asumen orden | Baja | Los tests existentes no afirman sobre orden; el sort es aditivo |
| El FE asume un orden distinto (ej. hardcodeado por categoría+orden de inserción) | Muy Baja | El FE ya agrupa — el orden intra-grupo beneficia la UX, no la rompe |

## Rollback

Revertir el cambio en `ListPlans.ts` y `naturalSort.ts` — vuelve al orden no determinista anterior. No hay data persistida ni migración que revertir.

## Dependencies

Ninguna dependencia externa. Cambio BE-only, aditivo de comportamiento.

## Success Criteria

- [x] `GET /api/plans` devuelve planes en orden natural por `code`: `IP-Air-20-10` antes que `IP-Air-50-15` antes que `IP-Air-100-30` (test de ruta con supertest incluido).
- [x] El orden es estable y TOTAL: desempate `name` → `id`; determinista ante codes no-numéricos (ej. `IP-BAJA`, `IP-REDUCCION`) y ante duplicados.
- [x] Guard de null: un `code`/`name` null/undefined nunca tira TypeError (posición determinista al principio).
- [x] Sort inmutable: el array del repo no se muta.
- [x] `InMemoryPlanRepository.list()` devuelve orden de inserción SIN sort propio; el port documenta que el orden no está garantizado.
- [x] `npm test` verde (incluyendo los nuevos tests de sort y los tests existentes de `plan.routes.test.ts`).
- [x] `tsc --noEmit` limpio.
- [x] DIP preservado: el sort vive en `application/`, no en `infrastructure/`.
