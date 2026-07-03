# Design: Enmascarar secretos de NAS en las lecturas

## Context

`GET /api/nas-servers` y `GET /api/nas-servers/:id` devuelven `radiusSecret`/`apiPassword` en
texto plano. El test que debía cubrir esto (`NasServer radiusSecret masking`) era un falso
positivo: `InMemoryNasRepository` sembraba el string `'••••••••'` directamente como si fuera el
"secreto" de los 3 NAS seed, así que el test pasaba comparando la máscara contra sí misma —
nunca hubo enmascarado real en el código. Cualquier NAS con un secreto real (creado vía
`CreateNasServer`, o ya en la DB de prod vía `PrismaNasRepository`) lo expone crudo hoy.

## Decisión 1 — Enmascarar en el USE CASE, no en el repo

El `NasRepository` (y su implementación Prisma) es el mismo repo que usa el flujo PPPoE /
enforcement para hablarle al NAS real (RouterOS, RADIUS). Si enmascaráramos ahí — por ejemplo
en `findAllNasServers()`/`findNasServerById()` — cualquier consumidor de ese repo (incluido el
lado de enforcement) recibiría la máscara en vez del secreto real, rompiendo esos flujos.

La frontera correcta es la capa de use case de LECTURA (`ListNasServers`, `GetNasServer`), que
son los únicos puntos que alimentan las rutas HTTP públicas de lectura. Se verificó (antes de
este cambio) que:
- `toNasTarget` (usado por el flujo de enforcement/PPPoE) solo lee `ip` + `port` del NAS, nunca
  el secreto.
- `RouterOsGateway` autentica contra RouterOS usando credenciales de **config de entorno**, no
  el `apiPassword`/`radiusSecret` del DTO.

Es decir: el secreto expuesto por `ListNasServers`/`GetNasServer` NUNCA se usa para auth real
downstream de esos dos use cases — enmascarar su salida es seguro y no rompe nada.

## Decisión 2 — Helper genérico `maskNasServerSecrets<T>()` en el dominio

```ts
export const NAS_SECRET_MASK = '••••••••';

export function maskNasServerSecrets<T extends { radiusSecret: string; apiPassword: string | null }>(nas: T): T {
  return {
    ...nas,
    radiusSecret: nas.radiusSecret ? NAS_SECRET_MASK : nas.radiusSecret,
    apiPassword: nas.apiPassword ? NAS_SECRET_MASK : nas.apiPassword,
  } as T;
}
```

- Vive en `domain/entities/nas.ts` junto al resto de la entidad — es lógica de negocio pura
  (qué significa "un secreto enmascarado"), no infraestructura.
- Es genérico (`<T extends {...}>`) para poder aplicarse tanto sobre `NasServer` crudo como
  sobre `NasServerDto` (que agrega `displayType`) sin perder el campo aditivo — el spread
  preserva todo lo que no sea `radiusSecret`/`apiPassword`.
- El `as T` al final es un cast controlado: el objeto resultante SÍ satisface `T` (mismo shape,
  solo 2 props reasignadas con tipos compatibles), pero TypeScript no puede inferir eso
  automáticamente sobre un spread genérico — es un patrón conocido, no una fuga de tipos.
- Solo enmascara valores truthy: un `null`/`''` ya almacenado se preserva. Esto importa para
  NAS tipo `ubiquiti` que legítimamente tienen `apiPassword: null` (no aplica API) — no queremos
  mostrar la máscara donde no hay nada que ocultar.

## Decisión 3 — Aplicar el masking DESPUÉS del enriquecido con live-stats

`ListNasServers`/`GetNasServer` tienen dos ramas: sin `ipNetworkRepo`/`orchestrator` (mapean
directo) y con ellos (pasan por `NasLiveStatsProvider.enrich/enrichAll`, que agrega
`clientCount`/`lastSeen` en vivo para NAS `radius_orchestrator`). El masking se aplica en AMBAS
ramas, y en la rama con live-stats, DESPUÉS del enriquecido (`enriched.map(maskNasServerSecrets)`)
— así el resultado final que llega a la ruta HTTP siempre está enmascarado, sin importar por
qué camino pasó.

## Decisión 4 — Sentinel de write-path en `UpdateNasServer`

Como las lecturas ahora devuelven la máscara, un formulario de edición en el FE va a mostrar
`'••••••••'` en el campo de secreto. Si el usuario edita OTRO campo (ej. `name`) y el form
reenvía el objeto completo tal cual lo tenía (incluida la máscara sin tocar), un PUT ingenuo
pisaría el secreto real guardado con el string `'••••••••'` literal — corrompiéndolo.

El sentinel en `UpdateNasServer.execute()` descarta del patch cualquier `radiusSecret`/
`apiPassword` que sea:
- `undefined` (el campo ni vino en el body — comportamiento normal de un `Partial<T>`),
- `''` (string vacío — un form que "limpió" el campo sin querer decir "bórralo"),
- `=== NAS_SECRET_MASK` (el form reenvió la máscara mostrada, no un valor nuevo real).

Un `apiPassword = null` explícito SÍ pasa intacto — es la única forma de limpiar
deliberadamente el campo (ej. downgrade de un NAS con API a uno sin ella). No hay un equivalente
"null explícito" razonable para `radiusSecret` porque el campo NO es opcional en la entidad
(`radiusSecret: string`, no `string | null`).

## Decisión 5 — Enmascarar TAMBIÉN la salida de create/update (gap CERRADO)

`nas.routes.ts` hace `res.json(server)` sobre lo que devuelven `createNasServer.execute()` y
`updateNasServer.execute()`. Para que el secreto no se filtre por NINGUNA puerta de la API, estos
dos use cases ahora enmascaran su PROPIA salida:

```ts
// CreateNasServer
const created = await this.repo.createNasServer(data);
return maskNasServerSecrets(created);

// UpdateNasServer (después del sentinel de INPUT)
const updated = await this.repo.updateNasServer(id, sanitized);
return updated ? maskNasServerSecrets(updated) : null;
```

Puntos clave:
- El repo persiste el secreto REAL — solo se enmascara la ENTIDAD DEVUELTA, no lo que se guarda.
  El flujo PPPoE/enforcement sigue recuperando el secreto real desde el repo directamente.
- En `UpdateNasServer`, el enmascarado es INDEPENDIENTE del sentinel de INPUT: el sentinel
  protege lo que se ESCRIBE (no pisar el secreto con la máscara/vacío entrantes); el masking de
  salida protege lo que se DEVUELVE. Se aplica con guarda de `null` (`updated ? ... : null`)
  porque `updateNasServer` devuelve `null` si el id no existe.
- `CreateNasServer` NO necesita sentinel de input — un alta siempre trae el secreto real y no hay
  un valor previo que proteger; solo se enmascara su respuesta.

Con esto, list/get/create/update enmascaran todos su respuesta HTTP → **no queda gap residual**:
el secreto real nunca sale de la API. (El caller de un POST ya conocía el secreto que mandó, pero
enmascarar igual la respuesta mantiene el contrato uniforme y evita que el valor quede en logs de
red / respuestas cacheadas.)

## Test Strategy (TDD, ya ejecutado)

1. **RED**: se agregó primero el helper de dominio (`NAS_SECRET_MASK`/`maskNasServerSecrets`,
   sin wire-up en los use cases) para que los tests nuevos compilaran. Se reemplazó el test
   falso-positivo de `NasUseCases.test.ts` por uno que planta un secreto REAL vía
   `createNasServer` y assertea que `ListNasServers`/`GetNasServer` devuelven la máscara; se
   agregó el test del sentinel de `UpdateNasServer`. Se corrió `npx jest ... --forceExit` →
   5 tests fallaron (2 en use-case, 3 en routes — masking no aplicado, sentinel no implementado),
   confirmando RED.
2. **GREEN**: se implementó el masking en `ListNasServers`/`GetNasServer` y el sentinel en
   `UpdateNasServer` → los 28 tests targeted (`NasUseCases.test.ts` + `nas.routes.test.ts`)
   pasaron. Se corrió la suite ampliada `NasLiveCounters.test.ts` + `nas.routes.test.ts` +
   `NasUseCases.test.ts` (43 tests, todos verdes) y `nasNextFreeIp.routes.test.ts` (6 tests,
   todos verdes) para cubrir otros consumidores directos de estos use cases. `tsc --noEmit`
   limpio.
3. **Cierre del gap residual (create/update output masking)** — segunda vuelta TDD: se agregaron
   2 tests HTTP en `nas.routes.test.ts` (POST y PUT enmascaran su respuesta pero persisten el
   secreto real). RED confirmado (2 fallando: las respuestas traían el crudo). Se implementó el
   masking de salida en `CreateNasServer`/`UpdateNasServer` (Decisión 5) → GREEN: 30/30 en los 2
   archivos targeted; `NasLiveCounters.test.ts` + `nasNextFreeIp.routes.test.ts` 21/21 sin
   regresión; `tsc --noEmit` limpio. Ningún test existente asserteaba el secreto crudo en las
   respuestas de POST/PUT (los de type/flip solo miran `type`), así que no hubo que ajustar
   ninguno.
