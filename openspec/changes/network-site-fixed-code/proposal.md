# Proposal — network-site-fixed-code (#51)

## Why

En `/admin/networking/settings` (Mapeo de nodos) el campo "código IClass" mostraba `iclassNodeCode`,
que en realidad es el **código de la LOCALIDAD** (en Prominense los nodos de IClass SON las ciudades —
ver #45). Eso mezcla tres conceptos distintos en la mente del operador:

1. **Identidad del sitio** — debería ser un código fijo, estable, no editable (ej. `NODO 12`).
2. **Localidad** — configurable vía el catálogo IClassNode del #45 (el select actual).
3. **Dirección** — la coordenada física que llega del mirror UISP.

Pedido textual: *"el código iclass… ¿es el código real o la localidad? debería poder setear la
localidad; el código iclass que sea el ID FIJO de la base de datos, ejemplo código = NODO [número];
la localidad se configura con el catálogo actual (#45) y la dirección es la coordenada que recibimos
desde uisp"*.

## What

1. **`NetworkSite.siteNumber`** — columna nueva `Int`, estable por sitio, asignada por secuencia
   dedicada en DB. El DTO expone `fixedCode = "NODO {siteNumber}"` (read-only).
2. **Separación de conceptos** en la entidad y la UI: `fixedCode` (identidad) ≠ `city`/localidad
   (editable, select #45) ≠ `address` (coordenadas UISP).
3. **Dirección desde coordenadas UISP**: cuando el sitio tiene `coordinates` del mirror UISP y
   `address` está vacía, el DTO/UI muestra `"{lat},{lng}"` como dirección sugerida. (El sync ya
   escribe `coordinates` y `address` con política manual-wins — ver hallazgo D abajo.)
4. **FE**: la tabla de Mapeo de nodos muestra `fixedCode` (badge mono, read-only), la localidad
   editable (select #45) y la dirección con hint "coordenadas UISP" cuando venga del sync.

## Decisión clave — el dispatch NO cambia a fixedCode

**El nodeCode/customerCode del dispatch a IClass se mantiene como `iclassNodeCode` (la localidad).**

Razón (verificada en código): en `SendTaskToIClass.ts` (tareas network), `resolvedNodeCode =
networkSite.iclassNodeCode` es el **nodeCode de enrutamiento** que IClass exige para aceptar la OS
y asignarla a la cuadrilla correcta. En Prominense, el nodo de IClass ES la ciudad/localidad
(#45). Forzar `fixedCode` (NODO n) como nodeCode rompería el enrutamiento — IClass rechazaría la OS
porque "NODO 12" no es un nodo válido en su catálogo.

`fixedCode` queda como **identidad interna estable** del sitio (cara al operador y para futuro #55).
El dispatch sigue intacto: nodeCode = customerCode = `iclassNodeCode` (localidad), city =
`task.iclassCityCode ?? city` (#54). Esto preserva back-compat total: OS ya enviadas no se tocan.

## Scope

- BE: schema + migración (siteNumber + secuencia), entidad `NetworkSite.siteNumber`/`fixedCode`,
  mappers (Prisma + in-memory), DTO de salida en las routes de networkSite.
- FE: `UispNodeMappingBody` (tabla Mapeo de nodos) — columna fixedCode + hint UISP en dirección.
- Sin cambios en dispatch (`dispatchTaskToIClass`, `SendTaskToIClass`, `ResendTaskToIClassWithNode`).

## Out of scope

- Reasignar el dispatch a fixedCode (futuro #55).
- Editar address manualmente desde la UI de mapeo (sigue como hoy / lo maneja el sync).
