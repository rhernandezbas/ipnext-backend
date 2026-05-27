# Estrategia de testing

Stack: **Jest + ts-jest + supertest**. Los tests viven en `src/__tests__/`,
espejando la estructura de capas.

```
src/__tests__/
├── application/     # Tests de use-cases (con adapters in-memory).
├── infrastructure/  # Tests de routes (supertest sobre Express).
├── domain/          # Tests de dominio (ej. errores tipados).
└── (raíz)           # Tests de integración cruzados (ej. tickets.routes, profile.routes).
```

## TDD estricto: red → green → refactor

El proyecto trabaja en **Strict TDD Mode**: primero el test que falla (red),
después el mínimo código para pasarlo (green), después refactor. Empezar siempre
por el test.

## Use-cases: testear con in-memory ports — NO mockear Prisma

La regla más importante: un test de use-case **no mockea Prisma**. Se le inyecta
el adapter `InMemory{X}` que implementa el mismo port.

Por qué: el use-case depende del **port**, no de Prisma. Mockear Prisma probaría
el adapter, no el caso de uso, y ataría el test a detalles de persistencia. El
in-memory respeta el contrato del port y corre en memoria, instantáneo.

Ejemplo — testear `SyncGestionRealClients`:

```ts
const gr = new InMemoryGestionRealPort([...clientesDePrueba]);
const mirror = new InMemoryClientMirrorRepository();
const state = new InMemorySyncStateRepository();
const useCase = new SyncGestionRealClients(gr, mirror, state, {
  now: () => new Date('2026-05-27'), // reloj inyectado → test determinista
});

const result = await useCase.execute();
expect(result.mode).toBe('backfill');
```

Notar el `now` inyectable: tanto el use-case como `GestionRealClient` aceptan un
reloj por opciones, lo que hace deterministas los tests de watermark y de la
password diaria MD5.

## Routes: supertest sobre la app Express

Los tests de routes levantan la app (o el router) con repos in-memory inyectados
y pegan HTTP real con supertest. Verifican status codes, shape de DTOs y el
mapeo de `DomainError` → status (ver el error handler en `app.ts`).

## Funciones puras: testear directo

`parseClientsResponse` / `parseContractsResponse` (en `GestionRealClient.ts`) se
exportan justamente para testear la normalización del payload GR sin red ni
mocks de axios.

## Resumen

| Qué testeás | Cómo | Doble |
|-------------|------|-------|
| Use-case | Inyectar `InMemory{X}` ports | in-memory adapter |
| Route | supertest sobre Express | repos in-memory |
| Parser / lógica pura | Llamada directa | ninguno |
| Adapter Prisma | (no se testea con in-memory; requiere DB) | — |
