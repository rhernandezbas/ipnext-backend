# ADR 0003 — Catálogos editables en DB en vez de enums

## Status

Aceptado · vigente.

## Context

Dimensiones de clasificación como **categoría de tarea**, **prioridad de tarea**,
tipos y categorías de proyecto, y stages de workflow son inherentemente
**configurables por el negocio**: cada ISP quiere sus propias categorías, sus
colores de prioridad y su orden. Modelarlas como `enum` de Prisma las congelaría:
agregar una categoría exigiría una migración y un deploy.

Existe precedente en el repo: `Admin.role` migró de `enum AdminRole` a `String`
respaldado por un catálogo editable (`AdminRoleDefinition`), ver commit
`admin_role_to_string` y `26869d28`.

## Decision

Modelar estas dimensiones como **catálogos editables en la base** (tablas con su
propio CRUD vía port + use-cases), no como enums TS/Prisma.

Ejemplos vigentes:

- `TaskCategory` (`src/domain/entities/taskCategory.ts`): `{ id, name, description }`.
  Port `TaskCategoryRepository`, use-cases `ListTaskCategory` / `Create` / `Update`
  / `Delete`, router `taskCategories.routes.ts`. Migración `add_task_categories`.
- `TaskPriority` (`src/domain/entities/taskPriority.ts`): `{ id, name, color, weight }`.
  El `color` (hex de la pill en la UI) y el `weight` (orden de urgencia) son
  **editables**. Migración `add_task_priorities`.
- `Stage.color` editable por workflow (commit `4389a71d`, migración
  `add_stage_color`).

## Consequences

**Positivas**
- El negocio cambia categorías, prioridades, colores y orden **sin deploy ni
  migración**: es data, no schema.
- Cada catálogo es un caso de uso CRUD limpio, testeable con in-memory.

**Negativas**
- Sin la seguridad de tipos de un enum: un valor inválido no lo atrapa el
  compilador, hay que validarlo en runtime / con FKs.
- Más tablas y más wiring (port + 2 adapters + ~5 use-cases por catálogo).

**Trade-off aceptado**: flexibilidad operativa del negocio > seguridad de tipos en
compilación, para dimensiones que el cliente espera poder editar.
