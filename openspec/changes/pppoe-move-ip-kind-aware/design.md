# Design: move de PPPoE consciente de la clase de IP

## Decisiones de arquitectura

### D1 — `supportedIpKinds` es DERIVADO, no persistido

**Decisión:** se calcula de los `IpPool` del NAS en cada lectura. NO se agrega columna a
`NasServer`, NO hay migración.

**Por qué:** la fuente de verdad ya existe (`IpPool.ipKind` + `nasId`). Persistirlo crearía un
segundo lugar que puede driftear del primero — exactamente el bug que acabamos de pagar con el
`poolType` hardcodeado, que quedó obsoleto cuando el NE8000 pasó a públicas **sin que nada lo
detectara**. Un dato derivado no puede quedar stale.

**Costo aceptado:** una lectura de pools por NAS. El `NasLiveStatsProvider` ya la hace
(`findPoolsByNas`, línea 69) para atribuir sesiones → costo incremental ~0.

### D2 — Un servicio de dominio puro resuelve la clase, y lo usan LOS DOS caminos

```
domain/services/ipKindSupport.ts      (puro, sin IO, testeable directo)
  supportedIpKinds(pools): IpKind[]
  resolveMovePoolType(supported, current): IpKind | null
```

**Por qué un servicio de dominio y no lógica suelta:** los dos consumidores —el move (BE
autoridad) y el DTO (hint para el FE)— tienen que responder **lo mismo**. Si cada uno lo
calcula por su cuenta, el FE va a ofrecer algo que el BE rechaza, o peor, va a esconder algo que
el BE aceptaría.

> Lección aplicada (memoria `la-funcion-que-decide-no-es-la-que-se-testea`): un concepto
> implementado dos veces termina con el test certificando una copia y prod corriendo la otra.
> Acá hay **una** función y las dos capas la consumen.

`resolveMovePoolType` implementa la regla del spec y devuelve `null` cuando no hay clase posible
— el caller traduce ese `null` al error tipado. Pura, sin excepciones, trivial de testear en
tabla.

### D3 — El cálculo va en su PROPIO try, fuera del bloque del orchestrator

En `NasLiveStatsProvider.enrich()`:

```ts
const displayType = ...;                       // ya existe, nunca degrada
const supportedIpKinds = await this.safeKinds(nas.id);   // NUEVO — try propio, cae a []
if (!routesViaOrchestrator(nas.type)) return { ...nas, displayType, supportedIpKinds };
try   { /* pools + sesiones + clientCount + lastSeen — SIN CAMBIOS */ }
catch { return { ...nas, displayType, supportedIpKinds }; }   // degrada stats, NO las clases
```

**Por qué:** hoy la lectura de pools (DB) y la de sesiones (orchestrator) comparten un `try`. Si
`supportedIpKinds` viviera ahí, desaparecería cada vez que el RADIUS esté caído — y el FE, sin
clases, esconde ambos botones y bloquea la operación por una causa no relacionada. Se paga una
segunda lectura de pools por NAS a cambio de que el campo no dependa de la red.

**Ojo con el early-return de la línea 63:** los NAS que no rutean por el orchestrator también
deben traer `supportedIpKinds`. Por eso se calcula ANTES de ese return.

### D4 — La conversión asigna del pool del DESTINO, siempre

`FindFreeIp(nasDestino, poolTypeResuelto)`. **Nunca** se conserva la IP previa al cambiar de
clase.

**Por qué:** una pública de un rango que el NAS destino no anuncia deja al cliente sin ruteo.
Precedente real documentado: los 7 "MercFibra" en otros nodos a los que NO se les forzó la
pública de Mercedes por exactamente este motivo.

### D4b — Los pools del NE8000 son TRANSPARENTES: el fallback entre pools es INTENCIONAL

**Decisión del usuario (2026-07-29), explícita:** el allocator sigue recorriendo TODOS los pools
públicos del NE8000 y entregando la primera IP libre, **sin afinidad por nodo**. Si
`pool-hipi-243` está lleno, dar una de `estudiantes-247` **es el comportamiento deseado**.

**Por qué es correcto:** los 18 pools públicos son **locales al propio NE8000**
(`pool-arzo-*`, `pool-hipi-*`, `pool-estu-*`, `pool-fibra-*`, `acceso-sur-*`) y todos se anuncian
desde ese mismo equipo. Un cliente físicamente en Hípico con una IP del rango de Estudiantes
rutea perfectamente, porque el que anuncia los dos /24 es el mismo BRAS. La correspondencia
nodo↔pool es un resabio de cuando cada nodo terminaba en su propio MikroTik y **cada router
anunciaba solo su rango** — ahí sí importaba (ver el caso del RDA Agote, que anuncia
`190.7.238.0/24` y `190.7.242.0/24` estáticos desde el router). En el NE8000 ya no.

**⚠️ NO "arreglar" esto.** Un servicio de Hípico con IP del rango de Estudiantes en el NE8000
**no es un bug**: es la transparencia buscada. Cualquier review que lo marque debe leer esta
decisión antes de tocar el `FindFreeIp`.

**Consecuencia para este change:** cero. `FindFreeIp` no se toca. La única cosa que cambia es
**qué `ipKind` se le pide**, no cómo elige el pool dentro de esa clase.

### D5 — El orden de operaciones NO cambia: abort antes de mutar

Se conserva el orden de la W1: resolver clase → `FindFreeIp` (si falla, **abort sin tocar nada**)
→ escribir RADIUS → persistir espejo → kick → registrar evento. La resolución de clase se inserta
como paso 0 y también aborta sin mutar.

**Por qué:** es la propiedad que hace el endpoint seguro de reintentar. Un fallo a mitad de camino
dejaría al servicio con IP nueva en el espejo y vieja en el RADIUS.

### D6 — `ipTypePreference` viaja en el update, no en el move

El move recibe solo `{ nasId }` (wire sin cambios) y **deriva** la clase del destino. El cambio
de tipo *sin* mover de NAS va por el `PATCH` de update, que suma `ipTypePreference` al body.

**Por qué no meterlo en el move:** el destino manda. Si el operador pide `cgnat` y el destino solo
acepta `public`, el pedido es incumplible — mejor que el backend derive lo único posible que
recibir una preferencia y contradecirla. Evita un wire con dos fuentes de verdad.

**Consecuencia para el FE:** cuando el NAS cambia Y el tipo cambia, el `handleEdit` ya hace
move-primero-update-después (líneas 813-830). El move resuelve la clase; el update posterior no
debe pisarla → **el update solo manda `ipTypePreference` si el NAS NO cambió**. Punto fino a
pinear con test: es exactamente el tipo de passthrough que la lección #28 marca como frágil.

## Impacto en archivos

**Backend**
- `domain/services/ipKindSupport.ts` — NUEVO (puro)
- `application/services/NasLiveStatsProvider.ts` — `supportedIpKinds` en el DTO + try propio
- `application/use-cases/MovePppoeToNas.ts` — línea 175: resolución en vez de hardcode
- `application/use-cases/UpdatePppoeService.ts` — aceptar `ipTypePreference`
- `application/dto/pppoe.dto.ts` — `ipTypePreference` opcional en el body de update
- `domain/errors/network.ts` — el error ya está parametrizado, no se toca

**Frontend**
- `types/nas.ts` + `api/nas.api.ts` — `supportedIpKinds` en el tipo
- `pages/customers/tabs/contracts/InternetPanel.tsx` — toggle filtrado + `ipTypePreference` en el update
- `utils/mapPppoeMoveError.ts` — mensaje parametrizado
- Componente propio de selector de tipo (tokens, `aria-pressed`, ≥44px) — reusar el existente si ya cumple

**Sin migración de DB.** Sin cambios de schema.

## Riesgos y mitigación

| Riesgo | Mitigación |
|---|---|
| Romper el move CGNAT→CGNAT que hoy funciona (5 NAS) | Test de regresión explícito que pinea el comportamiento actual |
| El FE esconde ambos tipos por un fallo de lectura | Fallback a mostrar ambos + BE como gate |
| El update pisa la clase que el move acaba de resolver | El update manda `ipTypePreference` SOLO si el NAS no cambió; pineado con test |
| Convertir le cambia la IP al cliente sin que el operador lo note | El impacto se muestra en el modal antes de guardar (regla de feedback de acciones de alto riesgo) |
| `supportedIpKinds` no refleja pools recién creados | Es derivado: la siguiente lectura ya lo trae. No hay caché a invalidar |
