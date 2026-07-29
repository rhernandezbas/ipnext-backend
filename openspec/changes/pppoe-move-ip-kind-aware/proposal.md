# Proposal: el move de PPPoE respeta la clase de IP del NAS destino

## Intent

Hoy **no se puede mover ningún servicio PPPoE al NE8000 desde la UI**. El use case
`MovePppoeToNas` pide siempre un pool `cgnat` del destino (línea 175, hardcodeado) y el NE8000
—que concentra 3272 de los 5468 servicios de la red— ya no tiene ni un pool CGNAT: quedó
100% en públicas tras los cutovers de julio. La operación principal está muerta y el operador
recibe un error que no le dice qué hacer.

Hacer que **la clase de IP se derive de lo que el NAS destino realmente soporta** (dato que ya
vive en `IpPool.ipKind`), que el move pueda **convertir** un servicio CGNAT a pública cuando el
destino solo acepta públicas, y que el FE **solo ofrezca los tipos posibles** para el NAS
elegido.

## Scope

### In Scope

- **`supportedIpKinds` derivado de los pools del NAS**, expuesto en el DTO de NAS como campo
  aditivo de presentación (molde de `displayType`, que ya existe en `NasLiveStatsProvider`).
  Calculado en su **propio** try/catch, desacoplado del orchestrator (ver exploración #5).
- **`MovePppoeToNas` deja de hardcodear `cgnat`**: resuelve el `poolType` contra las clases
  soportadas por el destino, usando el `ipTypePreference` persistido como desempate cuando el
  destino soporta ambas.
- **Conversión CGNAT→pública en el move** (decisión del usuario): si el destino solo acepta
  públicas, asigna la primera IP libre de un pool público del destino y persiste
  `ipTypePreference = 'public'`. Queda registrado en `PppoeNasMoveEvent`.
- **El modal de edición persiste `ipTypePreference`** (hoy no viaja al backend).
- **El FE esconde los tipos no soportados** por el NAS seleccionado; si soporta uno solo, queda
  fijado. Si `supportedIpKinds` no se pudo determinar → muestra ambos y **el BE rechaza**
  (fail-safe: molestar con un error claro es mejor que bloquear en silencio).
- **Mensaje de error parametrizado** en el FE: `NO_POOL_FOR_NAS_TYPE` deja de hardcodear "CGNAT".

### Out of Scope

- Cargar pools CGNAT en el NE8000 (decisión de red, no de app — y va en contra de la migración
  a públicas que ya se hizo).
- Tocar la semántica del **auto-move** (`AutoMovePppoe`): sigue siendo solo-CGNAT y saltea
  públicas a propósito. No se toca en este change.
- La ruta de **adopción** de pre-provisión: ya respeta el `ipTypePreference` y funciona.
- Reasignar IPs de servicios ya migrados por SQL a mano (reconciliaciones de julio).
- El guard `PPPOE_MOVE_PUBLIC_IP` / flujo `force` de la W1: se conserva tal cual.

## Capabilities

### New Capabilities

- **`nas-supported-ip-kinds`** — el sistema deriva y expone, por NAS, qué clases de IP puede
  asignar (`cgnat` / `public`), a partir de sus pools cargados.

### Modified Capabilities

- **`pppoe-move-nas`** — el move resuelve la clase de IP contra el destino en vez de asumir
  CGNAT, y convierte el servicio cuando el destino solo acepta la otra clase.
- **`pppoe-edit`** — el `ipTypePreference` elegido en el modal se persiste.

## Impacto y riesgo

**Desbloquea:** mover servicios al NE8000 (3272 servicios / el BRAS principal).

**Riesgo alto a cuidar — cambio de clase de IP = cambio de ruteo.** Convertir un CGNAT a
pública le cambia la IP al cliente y lo obliga a reconectar (el move ya hace kick). Peor: una
pública de un rango que **no se anuncia desde el NAS destino** deja al cliente sin ruteo. El
diseño debe asignar SIEMPRE del pool del destino, nunca conservar la IP vieja. Precedente
documentado: los 7 "MercFibra" en otros nodos a los que **no** se les forzó la pública de
Mercedes justamente para no dejarlos sin ruteo.

**Riesgo de regresión:** el move es un endpoint que ya funciona para los 5 NAS con pools CGNAT.
El cambio no debe alterar su comportamiento actual — un move CGNAT→CGNAT tiene que seguir
haciendo exactamente lo mismo. Se pinea con test.

## Verificación

- Move a NAS public-only (NE8000) con servicio CGNAT → convierte, asigna del pool público del
  destino, persiste `public`, registra el evento.
- Move CGNAT→CGNAT (CANEPA→Ugarte) → **sin cambios de comportamiento** (regresión).
- Move a NAS que soporta ambas (Agote) → respeta el `ipTypePreference` persistido.
- Move a NAS sin pools de ninguna clase → error tipado claro, nada mutado.
- `supportedIpKinds` presente aunque el orchestrator esté caído.
- E2E con Playwright sobre la app real: el botón "Privada" no aparece con el NE8000 elegido.
