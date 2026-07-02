# Tasks: Orden natural de planes por código (numeric-aware)

> TDD estricto (test primero, red → green → refactor). Cambio BE-only, sin migración, aditivo de comportamiento.
> Gate de salida: `npm test` verde + `tsc --noEmit` limpio + review de 1 revisor.
> No hay push sin OK del usuario.
>
> **(decisión post-review 2026-07-01: el catálogo muestra code; los fixtures code===name enmascaraban el mismatch)** — la clave es `code` con desempate `name` → `id`, guard de null, sort inmutable solo en `ListPlans`, in-memory sin sort propio. Las tareas 1-4 fueron re-ejecutadas bajo esta decisión.

## 1. Tests (primero — red)

- [x] 1.1 Crear `src/__tests__/application/ListPlans.sort.test.ts`. Importar `ListPlans` e `InMemoryPlanRepository`. Sembrar planes en orden inverso al natural (`IP-Air-100-30`, `IP-Air-20-10`, `IP-Air-80-30`, `IP-Air-50-15`, `IP-Air-100-100`, `IP-Air-50-50`, `IP-Air-80-80`) con **names deliberadamente contrarios al orden de code** (los fixtures code===name enmascaraban la clave). Llamar `execute()`. Afirmar que los `code`s del resultado son exactamente `['IP-Air-20-10', 'IP-Air-50-15', 'IP-Air-50-50', 'IP-Air-80-30', 'IP-Air-80-80', 'IP-Air-100-30', 'IP-Air-100-100']`.
- [x] 1.2 Agregar scenario: lista vacía → `[]` (sin error).
- [x] 1.3 Agregar scenario: un solo plan → array de un elemento.
- [x] 1.4 Agregar scenario: planes con codes no-numéricos (`IP-BAJA`, `IP-REDUCCION`, `IP-Air-20-10`) → no crashea, orden determinista.
- [x] 1.5 Agregar scenario: case-insensitive — `ip-air-20-10` aparece antes que `IP-Air-100-30`.
- [x] 1.6 (post-review) Agregar scenario: `IP-Air-20-10` antes que `IP-Alta-50-20` (A < Al, segmento no-numérico).
- [x] 1.7 (post-review) Agregar scenarios de desempate: names idénticos → orden RELATIVO por code (no solo count); code+name idénticos → orden por id (orden total).
- [x] 1.8 (post-review) Agregar scenarios de guard null: `code` undefined y `name` null → no crashea, posición determinista al principio.
- [x] 1.9 (post-review) Agregar scenario de inmutabilidad: el array del repo no se muta.
- [x] 1.10 (post-review) Agregar scenario del adapter: `InMemoryPlanRepository.list()` devuelve orden de inserción (sin sort propio).
- [x] 1.11 (post-review) Agregar test de RUTA HTTP en `plan.routes.test.ts`: `GET /api/plans` con supertest + in-memory responde el array ordenado por code (names contrarios al orden de code).
- [x] 1.12 Verificar que los tests FALLAN en rojo con el código actual (confirmado: 9 tests en rojo antes del fix).

## 2. Implementación — comparator + `ListPlans.ts` (green)

- [x] 2.1 En `src/application/utils/naturalSort.ts`: `naturalCompare` null-safe (`(a ?? '').localeCompare(b ?? '', undefined, { numeric: true, sensitivity: 'base' })`) y `planOrderComparator` con claves `code` → `name` → `id`.
- [x] 2.2 En `src/application/use-cases/ListPlans.ts`, aplicar el sort INMUTABLE sobre el resultado del repo:
  ```ts
  const plans = await this.repo.list();
  return [...plans].sort(planOrderComparator);
  ```
- [x] 2.3 Verificar que los tests de la tarea 1 pasan en verde.
- [x] 2.4 Verificar que `src/__tests__/infrastructure/plan.routes.test.ts` sigue en verde.

## 3. Reversión del sort en `InMemoryPlanRepository.ts` + contrato del port (green)

- [x] 3.1 (post-review — INVIERTE la tarea original) Revertir el sort agregado a `InMemoryPlanRepository.list()`: devuelve orden de inserción (`this.store.map(p => ({ ...p }))`), como Prisma devuelve orden de DB. Sin import de `naturalSort`.
- [x] 3.2 Documentar en el port `PlanRepository.list()` (JSDoc) que el orden NO está garantizado — el orden de presentación es responsabilidad del use case.
- [x] 3.3 Verificar que todos los tests de `plan.routes.test.ts` siguen en verde.

## 4. Refactor

- [x] 4.1 El comparator vive en `src/application/utils/naturalSort.ts` como única fuente (`naturalCompare` + `planOrderComparator`). Ya no hay consumo desde infrastructure (el in-memory no ordena).

## 5. Gate de calidad

- [x] 5.1 `npm test` — suite completa verde. Incluye los nuevos tests de sort y todos los tests existentes de planes.
- [x] 5.2 `tsc --noEmit` — sin errores de tipos.
- [x] 5.3 Verificar DIP: `src/application/` no importa nada de `src/infrastructure/`. `grep -r "from '@infrastructure" src/application/` debe dar vacío.

## 6. Review

- [x] 6.1 Review adversarial (2026-07-01) — resultado NO CLEAN: clave debía ser `code` (no `name`), faltaba guard de null, sort mutable, sort duplicado en el in-memory, cobertura faltante (A<Al, orden estable relativo, ruta HTTP). Fixes aplicados en esta wave.

## 7. Salida de fase

- [ ] 7.1 PR con descripción del cambio. Merge a `main` con OK del usuario.
- [ ] 7.2 Actualizar BACKLOG con el resultado. `sdd-archive` del change si corresponde.
