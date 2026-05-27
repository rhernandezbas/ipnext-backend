# ADR 0004 — Mirror read-only de Gestión Real

## Status

Aceptado · vigente.

## Context

Los clientes y contratos reales del ISP viven en **Gestión Real (GR)**, un sistema
externo (Real Software) con su propia API. Prominense necesita esos datos para sus
módulos (clientes, servicios, scheduling, billing), pero:

- GR es la **fuente de verdad**: Prominense no debe escribir sobre GR ni
  inventar clientes.
- La API de GR tiene rarezas: auth con password que rota a diario, clientes
  devueltos como objeto keyed-by-id, contratos como array, delta solo por fecha de
  modificación, sin feed de delta para contratos.
- Consultar GR en vivo en cada request sería lento y frágil (acopla la latencia y
  disponibilidad de Prominense a GR).

## Decision

Implementar un **mirror read-only** de GR dentro de la DB de Prominense, poblado
por **polling con watermark** (no en vivo):

1. **GR es la única fuente de escritura conceptual.** Prominense solo lee de GR y
   hace upsert local. Nunca escribe hacia GR.
2. **Identidad dual: surrogate UUID + business id externo.** Cada `Client` local
   mantiene su `id` UUID propio **y** una columna `grClienteId` (`@unique`,
   nullable). Idem `Service.grContratoId`. Así las filas pre-existentes (ej. de
   Splynx) conviven con las espejadas de GR sin colisión, y el upsert se hace por
   la business key externa.
3. **Mapeo de estados GR → enum local** en el adapter
   (`PrismaClientMirrorRepository.mapStatus`): `1→active`, `2→late`, `4→blocked`,
   `3/6→inactive`.
4. **El payload crudo de GR se persiste** en `Client.customAttributes` (JSON) para
   no perder fidelidad de datos que el modelo local todavía no representa.
5. **Separación de puertos read vs write.** El espejado escribe vía
   `ClientMirrorRepository` (write side), distinto de `CustomerRepository` (read
   side de la UI). Apagar el sync deja `ClientMirrorRepository` simplemente sin
   uso, sin afectar la lectura.

El diseño detallado del algoritmo de sync (backfill/delta, paginación,
idempotencia) está en [TDR 0001](../tdr/0001-gestion-real-sync-design.md).

## Consequences

**Positivas**
- Prominense lee de su propia DB: rápido y resiliente ante caídas de GR.
- La identidad dual permite mirror incremental idempotente y coexistencia con
  otros orígenes.
- El feature es **aditivo y aislable**: vive detrás de un flag (ver
  [ADR 0005](0005-in-process-scheduler-behind-flag.md)).

**Negativas**
- Los datos son **eventualmente consistentes**: hay lag igual al intervalo de
  polling (default 3 min) más la granularidad diaria del delta de GR.
- Se duplican datos. El mirror puede divergir si un sync falla a la mitad
  (mitigado por upserts idempotentes y re-scan del último día).
- `login` local se sintetiza como `gr:{grClienteId}` porque GR no provee uno y la
  columna es `@unique` requerida — es un valor namespaced, no un login real.
