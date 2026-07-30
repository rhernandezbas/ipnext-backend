# Nas Supported Ip Kinds Specification

## Purpose

Derivar, por NAS, **qué clases de IP puede asignar** (`cgnat` / `public`) a partir de los
`IpPool` cargados contra ese NAS. Es un dato **derivado, no persistido**: la fuente de verdad
son los pools, y un pool que se agrega o se borra cambia la respuesta sin ninguna migración.
Sirve a dos consumidores: (a) el `MovePppoeToNas`, que lo usa para elegir el pool destino en vez
de asumir CGNAT; (b) el FE, que lo usa para ofrecer solo los tipos posibles.

Se expone como campo **aditivo de presentación** en el DTO de NAS, molde exacto de
`displayType` (`NasLiveStatsProvider`): no se persiste, no toca `NasServer`, no requiere
migración.

**Fuera de alcance:** decidir qué pools debe tener un NAS (eso es operación de red), y
sincronizar nada con el router o el RADIUS.

## Requirements

### Requirement: Supported kinds derived from the NAS pools
El sistema DEBE (MUST) derivar `supportedIpKinds` de los `IpPool` asociados al NAS: una clase
está soportada si y solo si existe al menos un pool con ese `ipKind` para ese `nasId`.

> **El predicado DEBE ser IDÉNTICO al del allocator** (`FindFreeIp:45` → `pools.filter(p =>
> p.ipKind === input.type)`): filtra por `ipKind` y nada más. La entidad de dominio `IpPool` NO
> expone `status`, así que no se puede ni se debe filtrar por él acá. Si los dos predicados
> divergen, el FE ofrece una clase que el allocator rechaza (o esconde una que aceptaría) — que
> es exactamente el modo de falla que este change viene a eliminar.

#### Scenario: NAS with only public pools supports only public
- GIVEN un NAS con 18 pools `ipKind='public'` y 0 pools `cgnat` (caso real: NE8000 - Mercedes)
- WHEN se resuelven sus clases soportadas
- THEN `supportedIpKinds` es `['public']`

#### Scenario: NAS with only cgnat pools supports only cgnat
- GIVEN un NAS con 3 pools `ipKind='cgnat'` y 0 `public` (caso real: CANEPA)
- WHEN se resuelven sus clases soportadas
- THEN `supportedIpKinds` es `['cgnat']`

#### Scenario: NAS with both kinds supports both
- GIVEN un NAS con pools de ambas clases (caso real: RDA Agote, 3 cgnat + 2 public)
- WHEN se resuelven sus clases soportadas
- THEN `supportedIpKinds` contiene `'cgnat'` y `'public'`

#### Scenario: NAS with no pools supports nothing
- GIVEN un NAS sin ningún `IpPool` asociado
- WHEN se resuelven sus clases soportadas
- THEN `supportedIpKinds` es `[]` (vacío, NO se asume ninguna clase)

#### Scenario: Legacy pools with null ipKind are ignored
- GIVEN un NAS cuyos únicos pools tienen `ipKind: null` (pools legacy que no participan del allocator)
- WHEN se resuelven sus clases soportadas
- THEN `supportedIpKinds` es `[]`

### Requirement: Kinds must not degrade when the orchestrator is unavailable
El cálculo de `supportedIpKinds` DEBE (MUST) ser independiente del `RadiusOrchestratorGateway`:
un fallo del orchestrator NO puede vaciar ni omitir el campo, porque los pools se leen de la DB.

> **Por qué:** en `NasLiveStatsProvider.enrich()` la lectura de pools (DB, confiable) y la de
> sesiones (orchestrator, falible) comparten hoy un solo `try`. Meter el cálculo ahí haría
> desaparecer las clases cada vez que el RADIUS esté caído, y el FE —sin clases— esconderría
> ambos botones, bloqueando la operación por una causa no relacionada.

#### Scenario: Orchestrator down still yields supported kinds
- GIVEN el orchestrator falla (timeout / 5xx) al pedir las sesiones
- AND el NAS tiene pools cargados en la DB
- WHEN se enriquece el NAS
- THEN `clientCount`/`lastSeen` degradan al valor stored (comportamiento actual, sin cambios)
- AND `supportedIpKinds` viene igual, derivado de los pools

#### Scenario: Pool read failure yields empty kinds, never a 500
- GIVEN la lectura de pools falla
- WHEN se enriquece el NAS
- THEN `supportedIpKinds` es `[]` y la request NO falla (best-effort, molde del provider)

### Requirement: Exposed additively in the NAS DTO
El sistema DEBE (MUST) exponer `supportedIpKinds` en el DTO de NAS que consume el FE, sin
modificar la entidad `NasServer` ni el schema de Prisma.

#### Scenario: The NAS list carries the supported kinds
- GIVEN un operador con permiso `network.read`
- WHEN pide el listado de NAS
- THEN cada NAS incluye `supportedIpKinds` junto a `displayType`
- AND ninguna columna nueva se agregó a `NasServer`
