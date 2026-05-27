# ADR 0002 — DIP estricto: nada de Prisma en los use-cases

## Status

Aceptado · vigente · verificado en el código actual.

## Context

El Dependency Inversion Principle (DIP) dice que los módulos de alto nivel
(use-cases) no deben depender de los de bajo nivel (Prisma, axios), sino de
abstracciones. En la práctica es fácil que un use-case "tome un atajo" e importe
`prisma` directamente para una query rápida. Eso rompe la hexagonal: el core pasa
a depender de la DB.

## Decision

Un use-case **solo** puede depender de **ports** (`domain/ports/`), recibidos por
constructor. Está **prohibido** en `src/application/`:

- importar `@prisma/client` o `PrismaClient`,
- importar de `@infrastructure/*`,
- usar rutas relativas que trepen a `infrastructure/`.

Si un use-case necesita datos, se define un port en el dominio y se implementa en
infraestructura. El composition root (`app.ts`) inyecta la implementación.

## Consequences

**Positivas**
- Use-cases 100% testeables con in-memory ports, sin DB.
- El core no se entera de si los datos vienen de PostgreSQL, de un mock o de la
  API de Gestión Real.

**Verificación**
- Búsqueda de `@infrastructure`, `@prisma/client`, `PrismaClient` y
  `../../infrastructure` dentro de `src/application/` → **cero matches** al
  momento de esta doc. La regla se cumple hoy.

**Deuda / vigilar**
- El composition root sí usa Prisma directo para un lookup de FKs de scheduling
  (`prismaClientLookup` con `(prisma as any)[model]` en `app.ts`). Esto vive en
  **infraestructura**, así que no viola DIP, pero el `as any` evade el tipado.
  Aceptable como atajo de wiring; no replicar dentro de use-cases.

## Cómo recuperar la inversión si aparece una violación

Si encontrás un use-case importando algo de `infrastructure/` o de Prisma:
1. Definí (o reutilizá) un port en `domain/ports/`.
2. Hacé que el use-case dependa del port por constructor.
3. Mové la implementación concreta a `infrastructure/adapters/`.
4. Inyectá la implementación en `app.ts`.
