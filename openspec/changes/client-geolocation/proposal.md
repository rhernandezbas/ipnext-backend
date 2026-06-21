# Proposal: Geolocalización Prominense-owned (lat/lng/plusCode) — CLIENTE + CONTRATO

## Intent
Agregar ubicación GPS editable por el operador, **dato propio de Prominense (NO viene de GR)**, a DOS niveles:
- **Cliente**: `lat` / `lng` / `plusCode` (nuevos — el cliente no tenía nada).
- **Contrato**: `gpsLat` / `gpsLng` / `gpsPlusCode` (NUEVOS y SEPARADOS — el contrato YA tiene `lat`/`lng` de GR que quedan read-only y siguen sincronizando; estos son aparte y son del operador).

Mostrarlo lindo con un **mapa reutilizable** (mismo componente en cliente y contrato). Endpoints PATCH scoped para cargarlos.

## Decisiones del usuario
1. **Ambos niveles** (cliente + contrato).
2. **Contrato = campos nuevos separados**: los `lat`/`lng` de GR NO se tocan (read-only, siguen sync); se agregan `gpsLat`/`gpsLng`/`gpsPlusCode` Prominense-owned.
3. **Mismo componente** de mapa/editor en cliente y contrato.

## Validado (explore)
- El sync de clientes (`PrismaClientMirrorRepository.upsertClient`) y de contratos (`upsertContract`) usan **lista EXPLÍCITA de campos** → Prisma deja intactas las columnas no listadas. Precedente: `technology`/`name` de contratos (Prominense-owned con comentario-guard). **Cero cambio funcional en el sync** — solo comentarios-guard para que nadie agregue lat/lng/plusCode (cliente) ni gps* (contrato) al `data`.

## Scope

### BE
1. **Schema + migración** (nullable, segura):
   - `Client` += `lat Float?`, `lng Float?`, `plusCode String?`.
   - `Contract` += `gpsLat Float?`, `gpsLng Float?`, `gpsPlusCode String?` (los `lat`/`lng` de GR NO se tocan).
   - Comentarios-guard en `upsertClient` y `upsertContract`.
2. **Entities + mappers**: `Customer` += lat/lng/plusCode. La entity de Contract += gpsLat/gpsLng/gpsPlusCode. Los mappers (`toCustomer`, el de contrato) mapean `?? null`.
3. **Use cases** (genérico-pero-scoped, con validación compartida):
   - `UpdateClientLocation({ id, lat?, lng?, plusCode? })`.
   - `UpdateContractLocation({ id, gpsLat?, gpsLng?, gpsPlusCode? })`.
   - Validación común (util `validateLatLng`/`validatePlusCode`): lat ∈ [-90,90], lng ∈ [-180,180], plusCode formato OLC (regex). null permitido (limpiar). 404 si no existe.
4. **Repos**: `CustomerRepository.updateLocation(id, {lat,lng,plusCode})` + `ContractRepository.updateLocation(id, {gpsLat,gpsLng,gpsPlusCode})` (ports) + impl Prisma (whitelist explícito, SOLO esos campos) + in-memory.
5. **Rutas** (gate `clients.write`):
   - `PATCH /api/clients/:id` → `UpdateClientLocation` (whitelist lat/lng/plusCode; ignora/rechaza campos de GR). Upgradea el stub in-memory legacy.
   - `PATCH /api/contracts/:id/location` → `UpdateContractLocation` (whitelist gps*).
6. Wiring app.ts + tests (validación, whitelist rechaza campos de GR, 404, ambos niveles).

### FE (ui-ux-pro-max)
7. **Componente reutilizable** `GeoLocationEditor` (basado en el `UbicacionMap` de scheduling): props `{ value: {lat,lng,plusCode}, onSave, canEdit, title? }`. Pin arrastrable + buscar dirección + geocode. El plus_code se auto-calcula del lat/lng (util OLC propia) + editable. Muestra coords + **plus_code clickeable → Google Maps** (`?q=lat,lng`, target _blank rel noopener). Estado vacío lindo + CTA. a11y, SVG, responsive, reduced-motion.
8. **Cliente**: pestaña "Ubicación" en `CustomerDetailPage` → `<GeoLocationEditor>` cargando `customer.lat/lng/plusCode`, guarda con `useUpdateCustomer`.
9. **Contrato**: en la ficha del contrato (donde se ve cada contrato) → `<GeoLocationEditor>` cargando `contract.gpsLat/gpsLng/gpsPlusCode`, guarda con un hook nuevo `useUpdateContractLocation` (`PATCH /contracts/:id/location`). Mostrar también (read-only) la dirección/lat-lng de GR si existe, para referencia.
10. Tipos FE: `Customer` += lat/lng/plusCode; el tipo de Contract += gpsLat/gpsLng/gpsPlusCode + `UpdateContractLocationData`.

## Out of Scope
- Exponer la geo en la API externa (fácil de sumar después).
- Tocar/editar los lat/lng de GR (quedan read-only).

## Risks
| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| GR pisa los campos nuevos | **Nula** | sync usa lista explícita (verificado) + comentarios-guard |
| Confusión lat/lng GR vs gps del contrato | Media | nombres distintos (`gpsLat` vs `lat`); en el FE rotular claro ("GPS (cargado)" vs "Dirección GR") |
| Migración rompe prod | Baja | columnas nullable sin default; deploy corre `migrate deploy` (gateado) |
| PATCH filtra a campos de GR | Media | whitelist estricto + test que rechaza otros campos |
| plus_code / lat-lng inválidos | Baja | validación regex OLC + rangos en el use case |

## Success Criteria
- [ ] Cliente: `PATCH /api/clients/:id {lat,lng,plusCode}` (gate clients.write) actualiza solo esos campos, valida, rechaza campos de GR.
- [ ] Contrato: `PATCH /api/contracts/:id/location {gpsLat,gpsLng,gpsPlusCode}` ídem; los lat/lng de GR intactos.
- [ ] El sync de GR NO toca ninguno (verificado + comentarios-guard).
- [ ] FE: mismo `GeoLocationEditor` (mapa + plus_code + link Maps) en pestaña Ubicación del cliente Y en la ficha del contrato; guarda y persiste.
- [ ] tests BE+FE verdes + tsc/typecheck; review GO; verificación en vivo.
