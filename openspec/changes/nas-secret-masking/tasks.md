# Tasks: Enmascarar secretos de NAS en las lecturas

> TDD estricto. BE worktree `fix/nas-secret-masking` (nas-secret-masking-be).

## Domain

- [x] `src/domain/entities/nas.ts`: agregar `NAS_SECRET_MASK` y helper genérico
  `maskNasServerSecrets<T>()` (sin wire-up todavía — paso previo para que los tests compilen).

## Tests primero (RED)

- [x] `src/__tests__/application/NasUseCases.test.ts`: reemplazar el `describe('NasServer
  radiusSecret masking', ...)` falso-positivo por un test que planta un secreto REAL vía
  `createNasServer` y verifica que `ListNasServers`/`GetNasServer` devuelven `NAS_SECRET_MASK`.
- [x] `src/__tests__/application/NasUseCases.test.ts`: agregar `describe('UpdateNasServer secret
  sentinel', ...)` — máscara/vacío no pisan el secreto guardado; un valor real nuevo sí.
- [x] `src/__tests__/infrastructure/nas.routes.test.ts`: agregar `describe('nas.routes — secret
  masking + update sentinel', ...)` — GET list/get enmascaran y nunca leakean el real (assert
  sobre el JSON string completo); PUT con máscara no pisa; PUT con valor real sí actualiza.
- [x] Correr `npx jest src/__tests__/application/NasUseCases.test.ts
  src/__tests__/infrastructure/nas.routes.test.ts --forceExit` → confirmar RED (5 tests
  fallando: masking no aplicado, sentinel no implementado).

## Implementación (GREEN)

- [x] `src/application/use-cases/ListNasServers.ts`: `maskNasServerSecrets` en ambas ramas
  (con y sin live-stats), aplicado DESPUÉS del enriquecido en la rama con `orchestrator`.
- [x] `src/application/use-cases/GetNasServer.ts`: mismo patrón.
- [x] `src/application/use-cases/UpdateNasServer.ts`: sentinel — descartar del patch
  `radiusSecret`/`apiPassword` si vienen `undefined`, `''` o `=== NAS_SECRET_MASK`;
  `apiPassword: null` explícito pasa intacto.
- [x] Re-correr los mismos 2 archivos de test → GREEN (28/28).

## Cierre del gap residual — enmascarar salida de create/update (2da vuelta TDD)

- [x] **(test primero)** `nas.routes.test.ts`: POST con secreto real → respuesta enmascarada
  y sin el crudo, pero STORED queda real; PUT con secreto nuevo real → respuesta enmascarada
  y sin el crudo, pero STORED queda con el nuevo real. Correr → RED (2 fallando).
- [x] `src/application/use-cases/CreateNasServer.ts`: enmascarar la salida
  (`maskNasServerSecrets(created)`); el repo persiste el real.
- [x] `src/application/use-cases/UpdateNasServer.ts`: enmascarar SOLO el resultado
  (`updated ? maskNasServerSecrets(updated) : null`), manteniendo el sentinel de INPUT intacto.
- [x] Re-correr `nas.routes.test.ts` + `NasUseCases.test.ts` → GREEN (30/30).

## Verificación

- [x] Suite ampliada: `NasLiveCounters.test.ts` + `nas.routes.test.ts` + `NasUseCases.test.ts`
  → 43/43 verdes.
- [x] `nasNextFreeIp.routes.test.ts` (otro consumidor directo de `ListNasServers`/`GetNasServer`)
  → 6/6 verdes.
- [x] `npx tsc --noEmit` → limpio, sin errores.
- [x] DIP: el masking vive en `domain`/`application`, sin tocar `infrastructure/adapters/prisma`
  ni `InMemoryNasRepository` (el repo sigue devolviendo el secreto real tal cual está guardado).

## SDD

- [x] `openspec/changes/nas-secret-masking/proposal.md`
- [x] `openspec/changes/nas-secret-masking/specs/nas/spec.md` (delta: 2 Requirements MODIFIED
  + gap conocido documentado, sin Requirement nuevo)
- [x] `openspec/changes/nas-secret-masking/design.md`
- [x] `openspec/changes/nas-secret-masking/tasks.md` (este archivo)

## Salida

- [x] `GET /api/nas-servers` y `GET /api/nas-servers/:id` nunca exponen el secreto real.
- [x] `POST`/`PUT /api/nas-servers` enmascaran el secreto en su propia respuesta pero persisten
  el real → el gap residual quedó CERRADO: NINGUNA puerta de la API filtra el secreto real.
- [x] `PUT /api/nas-servers/:id` blindado contra pisar el secreto con la máscara/vacío (sentinel
  de INPUT, independiente del masking de salida).
