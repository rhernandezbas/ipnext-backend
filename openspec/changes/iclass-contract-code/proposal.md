# iclass-contract-code

## Why

Hoy el `customerCode` que viaja a IClass al crear una OS de tarea de cliente identifica al **CLIENTE** (derivado de `Client.grClienteId ?? splynxId ?? login`). El usuario pidió que identifique al **CONTRATO**: un cliente con N contratos debe ser N identidades distintas en IClass, y se pueden crear cuantas tareas se quieran siempre que cada una cuelgue de su contrato.

En IClass el "cliente" de la OS se crea/matchea inline por `customerCode` (no hay validación contra catálogo — el adapter hace upsert del customer en el payload de `createServiceOrder`). Por lo tanto el código es libre: cambiar qué identidad viaja es seguro a nivel API.

## What

Cuando una tarea de cliente tiene `contractId`, el `customerCode` enviado a IClass pasa a ser el **código del contrato** (`Contract.grContratoId`, único y estable, poblado siempre por el GR sync). Si la tarea NO tiene contrato (o, defensivamente, el contrato no tiene `grContratoId`), se mantiene el comportamiento actual: el código del cliente.

## Decisión de código: grContratoId, NO secuencia inventada

`Contract.grContratoId String? @unique` ya es el código de contrato REAL del negocio (GR), único y estable. El único path de creación de contratos es el GR sync (`PrismaClientMirrorRepository.upsertContract`), que SIEMPRE lo setea. No hay creación manual de contratos. Por eso NO se genera una secuencia `contractNumber` artificial: sería una segunda identidad redundante. El patrón secuencia (#51 nodeNumber) aplica cuando NO existe dato de negocio; acá SÍ existe. Sin migración de schema.

## Scope

- BE: entidad `ScheduledTask.contractCode`, mapper Prisma + in-memory, precedencia en `dispatchTaskToIClass`, DTO de contrato expone `code`.
- FE: badge mono con el código en la card del contrato (#42) — barato.

## Out of scope / back-compat

- OS ya enviadas con el customerCode viejo: IClass ya tiene esos "clientes". El cambio aplica solo a envíos NUEVOS; el historial de IClass tendrá ambas identidades (cliente viejo + contrato nuevo). Documentado, no se migra.
- Tareas de RED (`kind === 'network'`): sin cambios — siguen usando `networkSite.iclassNodeCode`.
- Tareas sin `contractId`: fallback al customerCode de cliente actual.
