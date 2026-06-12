# Design — network-site-fixed-code (#51)

## Hallazgos de exploración (código real, branch feat/51-site-fixed-code)

- **A — dispatch usa iclassNodeCode como nodeCode Y customerCode.**
  `SendTaskToIClass.ts:143` → `resolvedNodeCode = networkSite?.iclassNodeCode ?? NETWORK_CUSTOMER_CODE`,
  pasado como `nodeCode` a `dispatchToIClass`. Y `dispatchTaskToIClass.ts:119` →
  `effectiveCustomerCode = networkSite?.iclassNodeCode ?? NETWORK_CUSTOMER_CODE`.
  La city/localidad va por `effectiveCity = task.iclassCityCode ?? networkSite.city` (#54).
- **B — #45 setea city + iclassNodeCode juntos** con el `node.code` (anti-desync) en
  `AssignIClassNodeToNetworkSite.ts`. En Prominense los nodos de IClass SON las ciudades.
- **C — coordenadas UISP** existen como `UispSite.latitude/longitude (Float?)`. El sync
  `SyncUispMirror.ts` (paso 8, auto-import) YA escribe `NetworkSite.coordinates` (cols `lat`/`lng`)
  y `address` con política **manual-wins**: solo rellena si el campo está vacío/null.
- **D — no hay DTO separado** para NetworkSite: las routes hacen `res.json(site)` con la entidad
  de dominio directamente. Schema guarda coords como `lat Float?`/`lng Float?`.
- **E — última migración**: `20260705000000_tv_granular_permissions`. Próximo timestamp libre:
  `20260706000000+`.

## Decisiones

### D1 — fixedCode derivado de siteNumber Int por secuencia DB
- Columna `siteNumber Int` en `NetworkSite`, alimentada por una **secuencia Postgres dedicada**
  (`network_site_number_seq`) vía `DEFAULT nextval(...)`. Estable, monotónica, no reutiliza huecos.
- `fixedCode = "NODO " + siteNumber` se computa en el **mapper de dominio** (`toSite`), NO se persiste.
  Así un solo source of truth (el Int) y el string se deriva.
- **Migración** (timestamp `20260706000000`, aditiva, sin BEGIN/COMMIT):
  1. `CREATE SEQUENCE IF NOT EXISTS network_site_number_seq;`
  2. `ALTER TABLE "NetworkSite" ADD COLUMN IF NOT EXISTS "siteNumber" INTEGER;`
  3. **Backfill idempotente con guard**: numerar filas existentes con `siteNumber IS NULL` por
     `ROW_NUMBER() OVER (ORDER BY "createdAt", id)`, arrancando desde `nextval` consumido en orden.
     Guard: el `UPDATE ... WHERE siteNumber IS NULL` es idempotente (re-correr no re-numera lo ya numerado).
  4. `SELECT setval('network_site_number_seq', (SELECT COALESCE(MAX("siteNumber"),0) FROM "NetworkSite"));`
  5. `ALTER COLUMN "siteNumber" SET DEFAULT nextval('network_site_number_seq');`
  6. `ALTER COLUMN "siteNumber" SET NOT NULL;` + `ADD CONSTRAINT ... UNIQUE("siteNumber")` (IF NOT EXISTS via DO block).
- En el schema.prisma: `siteNumber Int @unique @default(autoincrement())` NO sirve (Prisma autoincrement
  crea su propia secuencia con nombre fijo). Se modela como `siteNumber Int @unique` y la secuencia/default
  se aplican vía SQL en la migración (Prisma respeta `@default(dbgenerated(...))` o se documenta como
  unmanaged default). Para evitar drift, usar `siteNumber Int @unique @default(dbgenerated("nextval('network_site_number_seq')"))`.

### D2 — entidad y mappers
- `NetworkSite.siteNumber: number` y `NetworkSite.fixedCode: string` (derivado) en la entidad de dominio.
  `fixedCode` es output-only (no entra en `create`/`update`). `siteNumber` tampoco se pasa en `create`
  (lo asigna la DB) — el tipo de `create` lo omite.
- `PrismaNetworkSiteRepository.toSite`: `siteNumber: row.siteNumber`, `fixedCode: "NODO " + row.siteNumber`.
- `InMemoryNetworkSiteRepository`: asigna `siteNumber` autoincremental en `create` (contador interno),
  computa `fixedCode` igual. `seedSites` respeta el siteNumber provisto o asigna uno.

### D3 — address desde coordenadas UISP (output-only suggestion)
- El sync NO cambia (ya escribe coordinates/address manual-wins). Lo que agregamos es **derivación de
  display**: el DTO/entidad ya expone `coordinates`. El FE muestra como dirección:
  `address` si existe; si no, y hay `coordinates`, muestra `"{lat},{lng}"` con hint "coordenadas UISP".
  - Política confirmada: NO pisar ediciones manuales. La dirección manual gana siempre. La coordenada
    es solo fallback de display cuando address está vacía. (Coherente con manual-wins del sync.)
- No se agrega lógica nueva de escritura — solo presentación. Esto mantiene el cambio aditivo y seguro.

### D4 — dispatch sin cambios (back-compat)
- Confirmado por hallazgo A+B: el nodeCode de IClass DEBE ser el código de localidad (`iclassNodeCode`),
  no `fixedCode`. Se documenta y NO se toca `dispatchTaskToIClass`/`SendTaskToIClass`/`Resend...`.
- `iclassNodeCode` mantiene su rol: nodeCode + customerCode del dispatch = código de la LOCALIDAD.
  `fixedCode` es identidad informativa/UI. Futuro #55 podría mover customerCode→fixedCode si IClass lo permite.

## Wire contract (DTO de NetworkSite — sin cambios estructurales salvo +2 campos)

```jsonc
{
  "id": "uuid",
  "name": "...",
  "siteNumber": 12,          // NUEVO — Int estable
  "fixedCode": "NODO 12",    // NUEVO — derivado, read-only
  "address": "Av. Siempreviva 742" | "",
  "city": "ROSARIO",         // localidad = node.code (#45)
  "coordinates": { "lat": -32.9, "lng": -60.6 } | null,
  "iclassNodeCode": "ROSARIO" | null,  // código de localidad (dispatch)
  "uispSiteId": "..." | null,
  // ... resto igual
}
```

FE deriva `addressDisplay = address || (coordinates ? \`${lat},${lng}\` : "")` y muestra hint
"coordenadas UISP" cuando usa el fallback.

## Riesgos
- **Migración en prod con muchas filas**: el backfill con ROW_NUMBER es O(n) una sola vez; aceptable.
- **Drift Prisma vs secuencia manual**: mitigado usando `dbgenerated("nextval(...)")` en el schema.
- **NOT NULL antes de backfill**: el orden de la migración (add nullable → backfill → set not null) lo evita.
