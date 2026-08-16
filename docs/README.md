# Prominense — Documentación de arquitectura del backend

Prominense es el backend de gestión de un ISP (réplica funcional de Splynx). Hoy
una parte central de sus datos de clientes y contratos se alimenta de la **API
externa de Gestión Real** a través de un **mirror read-only** (polling con
watermark). El stack es Node + TypeScript (strict) + Express 4 + Prisma 7 sobre
PostgreSQL, construido en **arquitectura hexagonal estricta** (Ports & Adapters).

Esta documentación describe la arquitectura **real** del repo, no un ideal.
Donde hay deuda técnica o desviaciones de la hexagonal, se marca de forma
explícita.

## Índice

### Arquitectura
- [overview.md](architecture/overview.md) — capas hexagonales, dirección de dependencias, regla DIP.
- [layers.md](architecture/layers.md) — qué vive en cada capa y qué puede importar qué.
- [ports-and-adapters.md](architecture/ports-and-adapters.md) — convención de ports y adapters (Prisma / in-memory).
- [testing-strategy.md](architecture/testing-strategy.md) — TDD estricto, use-cases con in-memory, supertest para routes.

### ADR — Architecture Decision Records
- [0001](adr/0001-hexagonal-architecture.md) — Arquitectura hexagonal.
- [0002](adr/0002-dip-strict-no-prisma-in-usecases.md) — DIP estricto: nada de Prisma en use-cases.
- [0003](adr/0003-editable-catalogs-over-enums.md) — Catálogos editables en DB en vez de enums.
- [0004](adr/0004-gestion-real-readonly-mirror.md) — Mirror read-only de Gestión Real.
- [0005](adr/0005-in-process-scheduler-behind-flag.md) — Scheduler in-process detrás de un flag.

### TDR — Technical Design Records
- [0001](tdr/0001-gestion-real-sync-design.md) — Diseño del sync de Gestión Real.
- [0002](tdr/0002-prisma-migrations-workflow.md) — Workflow de migraciones Prisma.

### Negocio
- [domain-glossary.md](business/domain-glossary.md) — glosario del dominio.
- [domain-rules.md](business/domain-rules.md) — reglas de negocio observadas.

### Integraciones e investigaciones
- [iclass-integration.md](iclass-integration.md) — integración con IClass (despacho de órdenes de servicio).
- [investigacion-iclass-estados.md](investigacion-iclass-estados.md) — exploración (2026-06-14): traer los estados de IClass a Prominense. **No es implementación.**
- [EXTERNAL-API.md](EXTERNAL-API.md) — API externa para terceros.
- [NEWS-API.md](NEWS-API.md) — API de novedades.
- [gigared/](gigared/) — PDFs de referencia de la API del partner Gigared (TV).

## Mapa rápido del código

```
src/
├── domain/          # Núcleo puro: entities, ports (interfaces), errors. Sin deps externas.
├── application/     # Use-cases (un archivo = un caso) + DTOs. Dependen de ports, nunca de adapters.
├── infrastructure/  # Adapters concretos: prisma/, in-memory/, jwt/, splynx/, gestion-real/.
│   ├── http/        # Express: app.ts (composition root), routes/, middleware/.
│   ├── scheduling/  # Scheduler in-process del mirror GR.
│   ├── database/    # Cliente Prisma compartido.
│   └── config.ts    # Validación fail-fast de env vars.
└── main.ts          # Entry point: levanta el server y arranca el sync GR (opt-in).
```
