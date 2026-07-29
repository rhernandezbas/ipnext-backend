# Pppoe Move Nas Specification (delta)

## Purpose

Delta sobre la capability existente `pppoe-move-nas` (W1). El move deja de asumir que el NAS
destino tiene pools CGNAT y **resuelve la clase de IP contra lo que el destino realmente
soporta**. Cuando el destino solo acepta la otra clase, el move **convierte** el servicio:
asigna una IP del pool del destino y persiste el nuevo `ipTypePreference`.

**Invariante que NO cambia:** un move entre NAS que ambos soportan CGNAT se comporta
EXACTAMENTE como hoy. Todo el resto de la W1 (guard `PPPOE_MOVE_PUBLIC_IP` + flujo `force`,
kick, registro en `PppoeNasMoveEvent`, abort sin mutar ante `NoFreeIp`) se conserva.

## Requirements

### Requirement: Pool kind resolved against the destination NAS
El sistema DEBE (MUST) resolver el `poolType` del move a partir de las clases soportadas por el
NAS destino (`supportedIpKinds`), y NO DEBE (MUST NOT) hardcodear `'cgnat'`.

Regla de resolución:
1. Si el destino soporta la clase actual del servicio (`ipTypePreference`) → usa esa clase.
2. Si el destino soporta **exactamente una** clase distinta de la actual → usa esa (conversión).
3. Si el destino no soporta ninguna clase → error tipado, nada mutado.

#### Scenario: Move to a public-only NAS converts a CGNAT service
- GIVEN un servicio con `ipTypePreference='cgnat'` e IP `100.64.60.200` en un NAS CGNAT
- AND el NAS destino soporta únicamente `public` (caso real: NE8000 - Mercedes)
- WHEN se mueve el servicio a ese NAS
- THEN se le asigna la primera IP libre de un pool `public` del **destino**
- AND `ipTypePreference` queda en `'public'`
- AND `nasId` queda en el destino
- AND el movimiento queda registrado en `PppoeNasMoveEvent`

#### Scenario: CGNAT to CGNAT move is unchanged (regression pin)
- GIVEN un servicio `cgnat` en un NAS con pools CGNAT
- AND el NAS destino también soporta `cgnat`
- WHEN se mueve el servicio
- THEN se le asigna una IP del pool `cgnat` del destino
- AND `ipTypePreference` sigue siendo `'cgnat'`
- AND el comportamiento es idéntico al previo a este change

#### Scenario: Destination supporting both kinds keeps the persisted preference
- GIVEN un servicio con `ipTypePreference='cgnat'`
- AND el NAS destino soporta `cgnat` y `public` (caso real: RDA Agote)
- WHEN se mueve el servicio
- THEN se le asigna una IP del pool `cgnat` (gana la preferencia persistida)
- AND `ipTypePreference` NO cambia

#### Scenario: Destination with no pools at all fails without mutating
- GIVEN un NAS destino sin ningún `IpPool`
- WHEN se intenta mover un servicio a ese NAS
- THEN la operación falla con un error tipado que nombra la clase buscada
- AND el servicio conserva su `nasId`, su `remoteAddress` y su `ipTypePreference`
- AND no se emitió ningún kick ni se escribió en el RADIUS

### Requirement: The assigned IP always comes from the destination pool
El sistema NO DEBE (MUST NOT) conservar la IP previa al convertir de clase: la IP asignada DEBE
(MUST) pertenecer a un pool del NAS destino.

> **Por qué:** una IP pública de un rango que el NAS destino no anuncia deja al cliente **sin
> ruteo**. Precedente real: los 7 servicios "MercFibra" alojados en otros nodos a los que NO se
> les forzó la pública de Mercedes exactamente por este motivo.

#### Scenario: Converted service does not keep its old address
- GIVEN un servicio con IP `100.64.60.200` (rango del NAS origen)
- WHEN se convierte y mueve a un NAS public-only
- THEN su nueva `remoteAddress` cae dentro de un `IpPool` del NAS destino
- AND NO es `100.64.60.200`

### Requirement: Typed error names the actual pool kind
El error de "no hay pool para la clase" DEBE (MUST) transportar la clase realmente buscada, y el
FE DEBE (MUST) mostrarla en el mensaje en vez de asumir CGNAT.

#### Scenario: Message reflects a missing public pool
- GIVEN el move resolvió `poolType='public'` y el destino no tiene pools públicos
- WHEN el FE recibe el error
- THEN el mensaje al operador menciona **pública**, no CGNAT
