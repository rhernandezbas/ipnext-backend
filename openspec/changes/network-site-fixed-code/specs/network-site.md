# Spec delta — NetworkSite fixed code (#51)

## ADDED — REQ-SITE-FIXED-1: siteNumber estable por sitio
Cada `NetworkSite` DEBE tener un `siteNumber` (Int) único, asignado por la base de datos
mediante una secuencia dedicada (`network_site_number_seq`), estable durante toda la vida del sitio.

### Scenario: nuevo sitio recibe siteNumber automático
- WHEN se crea un NetworkSite (manual o auto-import UISP)
- THEN la DB asigna `siteNumber = nextval(network_site_number_seq)`
- AND el caller NO provee `siteNumber` (lo omite el tipo de `create`)

### Scenario: backfill idempotente de sitios existentes
- WHEN se aplica la migración sobre una tabla con filas sin `siteNumber`
- THEN cada fila existente recibe un `siteNumber` único por orden de `createdAt, id`
- AND re-aplicar la migración NO re-numera filas ya numeradas (guard `WHERE siteNumber IS NULL`)
- AND `siteNumber` queda `NOT NULL` y `UNIQUE`

## ADDED — REQ-SITE-FIXED-2: fixedCode derivado read-only
El DTO/entidad de `NetworkSite` DEBE exponer `fixedCode = "NODO {siteNumber}"`, derivado del Int,
no persistido, y NO editable desde ninguna route.

### Scenario: fixedCode en la respuesta
- WHEN un cliente lee un NetworkSite con siteNumber=12
- THEN la respuesta incluye `fixedCode: "NODO 12"` y `siteNumber: 12`

### Scenario: fixedCode no es editable
- WHEN un PUT incluye `fixedCode` o `siteNumber` en el body
- THEN esos campos se ignoran (no se persisten)

## UNCHANGED — REQ-SITE-DISPATCH-1: el dispatch usa iclassNodeCode (localidad)
El nodeCode/customerCode enviado a IClass para tareas network SIGUE siendo `iclassNodeCode`
(código de localidad del catálogo #45). `fixedCode` NO se usa en el dispatch.

### Scenario: dispatch network sin cambios
- WHEN se envía una tarea network a IClass
- THEN nodeCode = customerCode = networkSite.iclassNodeCode (back-compat #29/#54)
- AND city = task.iclassCityCode ?? networkSite.city

## ADDED — REQ-SITE-ADDR-1: dirección desde coordenadas UISP (display fallback)
La UI de Mapeo de nodos DEBE mostrar como dirección: `address` si existe; si está vacía y hay
`coordinates`, mostrar `"{lat},{lng}"` con hint "coordenadas UISP". Las ediciones manuales de
`address` ganan siempre (no se pisan).

### Scenario: address manual gana
- WHEN un sitio tiene address="Calle 1" y coordinates={lat,lng}
- THEN la UI muestra "Calle 1" (sin hint UISP)

### Scenario: fallback a coordenadas
- WHEN un sitio tiene address="" y coordinates={lat:-32.9, lng:-60.6}
- THEN la UI muestra "-32.9,-60.6" con hint "coordenadas UISP"
