# ADR 0001 — Arquitectura hexagonal (Ports & Adapters)

## Status

Aceptado · vigente.

## Context

Prominense replica funcionalidad de Splynx (gestión de ISP) y debe integrarse con
sistemas externos heterogéneos: el legacy **Splynx** (tickets, billing) y la API
externa de **Gestión Real** (clientes, contratos). Las fuentes de datos pueden
cambiar (hoy Splynx, mañana Gestión Real como fuente de verdad de clientes). Si la
lógica de negocio estuviera acoplada a Prisma o a un cliente HTTP concreto, cada
cambio de origen rompería el core.

## Decision

Adoptar **arquitectura hexagonal estricta** en tres capas:

- `domain/` — núcleo puro: entities, **ports** (interfaces), errores tipados.
- `application/` — use-cases que orquestan dominio + ports.
- `infrastructure/` — adapters concretos (Prisma, in-memory, JWT, Splynx,
  Gestión Real), Express y config.

La dirección de dependencias va **siempre hacia adentro**:
`infrastructure → application → domain`. El dominio no conoce a nadie.

El wiring de dependencias se concentra en un único **composition root**:
`createApp()` en `src/infrastructure/http/app.ts`.

## Consequences

**Positivas**
- Los use-cases son testeables sin DB ni red (se inyectan in-memory ports).
- Cambiar de origen de datos (Splynx → Gestión Real, Prisma → otra DB) toca solo
  los adapters y el wiring, nunca el core.
- El mirror de Gestión Real se enchufó como un set de adapters nuevos sin tocar la
  lógica existente de clientes.

**Negativas / costos**
- Mucho boilerplate: cada feature requiere port + adapter Prisma + adapter
  in-memory + wiring. `app.ts` ya supera las 800 líneas de wiring.
- Indirección: para seguir un flujo hay que saltar route → use-case → port →
  adapter.

**Trade-off aceptado**: el costo de boilerplate se paga una vez; la flexibilidad
ante cambios de integración se cobra siempre.
