# Proposal: Enmascarar secretos de NAS en las lecturas

## Intent

`GET /api/nas-servers` y `GET /api/nas-servers/:id` devuelven `radiusSecret`/`apiPassword`
**en texto plano**. Enmascararlos en la capa de use case (no en el repo), y blindar el
write-path para que un PUT con la máscara (o vacío) no pise el secreto real guardado.

## Why

- Los tests existentes daban un falso positivo: `InMemoryNasRepository` sembraba
  `radiusSecret = '••••••••'` directamente en el seed, así que el test
  `NasServer radiusSecret masking` pasaba SIN que hubiera ningún enmascarado real en el código
  — cualquier NAS creado con un secreto real (`CreateNasServer`, o el Prisma repo en prod)
  lo devuelve crudo.
- El repo (`NasRepository`/`PrismaNasRepository`) es compartido con el flujo PPPoE/enforcement,
  que SÍ necesita el secreto real (para configurar el NAS, autenticar contra RouterOS, etc.).
  Enmascarar ahí rompería ese flujo. El enmascarado tiene que vivir en la frontera de
  presentación: los use cases de lectura (`ListNasServers`/`GetNasServer`), que son los únicos
  que alimentan las rutas HTTP de lectura.
- Se verificó que el secreto NUNCA se usa desde la salida de estos use cases para auth real:
  `toNasTarget` solo lee `ip`+`port`; `RouterOsGateway` usa credenciales de config de entorno,
  no el DTO. Enmascarar la salida de estos dos use cases es seguro.

## Scope

### In Scope

- `src/domain/entities/nas.ts`: constante `NAS_SECRET_MASK` + helper `maskNasServerSecrets<T>()`.
- `ListNasServers.execute()` y `GetNasServer.execute()`: enmascaran `radiusSecret`/`apiPassword`
  en TODAS las ramas (con y sin live-stats/orchestrator).
- `UpdateNasServer.execute()`: sentinel de write-path — si `radiusSecret`/`apiPassword` vienen
  `undefined`, `''` o `=== NAS_SECRET_MASK`, se descartan del patch antes de llamar al repo
  (para que un PUT que "reenvía" la máscara mostrada en el form no borre/pise el secreto real).
  Un `null` explícito en `apiPassword` SÍ pasa (permite limpiar el campo).

- `CreateNasServer.execute()` y `UpdateNasServer.execute()`: enmascaran su PROPIA salida (la
  entidad que devuelven, que las rutas `POST`/`PUT` hacen `res.json`). El repo persiste el
  secreto REAL — solo se enmascara la respuesta. Así el secreto no se filtra por NINGUNA puerta
  de la API (list, get, create, ni update). El sentinel de INPUT de `UpdateNasServer` (que evita
  pisar el secreto guardado con la máscara/vacío) se mantiene sin cambios.

### Out of Scope

- El almacenamiento del secreto: create/update siguen guardando el valor REAL en la DB
  (el enmascarado es solo de presentación, sobre la respuesta HTTP).
- Ninguna migración de schema — no hay cambio de datos, solo de qué se expone en la respuesta.

## Capabilities

### Modified Capabilities
- `nas`: TODAS las respuestas de la API de NAS servers (list, get, create, update) enmascaran
  los secretos; el update además tiene un sentinel de INPUT anti-pisado. El repo sigue
  persistiendo el secreto real (enmascarado solo en la salida).

## Approach

1. TDD estricto: se agregó primero la constante+helper de dominio (para que los tests compilen),
   se reemplazó el test de masking (que era un falso positivo) por uno que planta un secreto
   REAL vía `createNasServer` y verifica que list/get lo enmascaran; se agregó el test del
   sentinel de `UpdateNasServer`; se corrieron ambos → RED confirmado.
2. Se implementó el enmascarado en `ListNasServers`/`GetNasServer` y el sentinel en
   `UpdateNasServer` → GREEN.
3. Se agregaron los mismos casos a nivel HTTP (`nas.routes.test.ts`) para blindar el contrato
   real de la API (incluye assert de que el secreto real NUNCA aparece en el JSON de respuesta).

## Affected Areas

| Área | Impacto |
|------|---------|
| `src/domain/entities/nas.ts` | Agregado — `NAS_SECRET_MASK` + `maskNasServerSecrets()` |
| `src/application/use-cases/ListNasServers.ts` | Modified — enmascara en ambas ramas |
| `src/application/use-cases/GetNasServer.ts` | Modified — enmascara en ambas ramas |
| `src/application/use-cases/CreateNasServer.ts` | Modified — enmascara su salida (persiste el real) |
| `src/application/use-cases/UpdateNasServer.ts` | Modified — sentinel de INPUT + enmascara su salida |
| `src/__tests__/application/NasUseCases.test.ts` | Modified — reemplaza el test falso-positivo + agrega el del sentinel |
| `src/__tests__/infrastructure/nas.routes.test.ts` | Modified — casos HTTP de masking (list/get/create/update) + sentinel |

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Romper el flujo PPPoE/enforcement que sí necesita el secreto real | Baja | El enmascarado vive SOLO en los use cases de lectura (list/get), NUNCA en el repo; se verificó que `toNasTarget`/`RouterOsGateway` no consumen el secreto desde ahí |
| Un PUT legítimo que quiere limpiar `apiPassword` a `null` queda bloqueado por el sentinel | Baja | El sentinel solo descarta `undefined`/`''`/máscara; `null` explícito pasa intacto |
| El FE reenvía la máscara mostrada en el form como si fuera el valor real (pisando el secreto) | Media (antes del fix) | Sentinel en `UpdateNasServer` la descarta del patch antes de tocar el repo |

## Rollback

Aditivo + acotado a 3 archivos de use case + 1 de dominio. Rollback = `git revert`.

## Dependencies

Ninguna. No hay cambio de schema.

## Success Criteria

- [x] `GET /api/nas-servers` y `GET /api/nas-servers/:id` nunca exponen `radiusSecret`/`apiPassword`
      reales — devuelven `NAS_SECRET_MASK` cuando el valor almacenado es no-vacío.
- [x] `POST /api/nas-servers` enmascara el secreto en su propia respuesta pero persiste el real.
- [x] `PUT /api/nas-servers/:id` enmascara el secreto en su propia respuesta pero persiste el
      nuevo real; con la máscara o `''` NO pisa el secreto guardado (sentinel de INPUT).
- [x] Ninguna puerta de la API (list/get/create/update) filtra el secreto real en su respuesta —
      el "gap residual" quedó CERRADO.
- [x] `npm test` (suite NAS + relacionadas) verde; `tsc --noEmit` limpio.
