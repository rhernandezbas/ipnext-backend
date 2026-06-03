<!-- generated from engram topic_key: sdd/equipment-catalog/proposal -->
## Proposal — equipment-catalog

> Cubre los items #5 + #6 + #3 del backlog 2026-06-03. Multi-repo (BE Node/Prisma + FE React/Vite). Strict TDD. Migraciones aditivas. El item #1 (default de proyecto + descripción obligatoria en CreateTaskModal) queda FUERA — es otro dominio, va como cambio aparte.

### Why
Hoy los tipos de equipo (`ONU | ROUTER | ANTENA | REPETIDOR | OTROS`) son un **enum hardcodeado duplicado en 4 lugares** (BE: `domain/entities/device-type.ts` + `contract-installed-item.ts`; FE: `SuggestionCard.tsx` + `ServiceInventorySection.tsx`) y consumido por todo el pipeline OCR (prompt del modelo + `normalizeQwenDeviceType` + `classifyDeviceType` + guards de confirm/route). Agregar un tipo nuevo (ej. "switch", "mikrotik") exige tocar código y desplegar. El usuario quiere administrarlos desde una página de configuración. Además, el toggle "Revisado por inventario" hoy es un booleano ciego: no registra **quién** ni **cuándo**, así que no hay trazabilidad de la revisión.

### What changes

**F1 — Catálogo de tipos de equipo (data-driven) [#5]**
- Nueva tabla Prisma `DeviceTypeCatalog` (espeja `TaskPriority`: `id`, `name @unique`, `label?`, `active`, `sortOrder`, timestamps). Migración aditiva que **siembra los 5 valores actuales** (ONU/ROUTER/ANTENA/REPETIDOR/OTROS) para no romper datos existentes — las columnas afectadas YA son `String` plano (no enums Prisma), así que NO se altera ninguna columna.
- Stack hexagonal nuevo espejando `TaskPriority`: entidad de dominio, port `DeviceTypeCatalogRepository`, adapters Prisma + InMemory, 5 use-cases (List/Get/Create/Update/Delete), errores tipados (NotFound/NameConflict/InUse), DTOs Zod, route factory, wiring en `app.ts`.
- Borrado protegido: no se puede eliminar un tipo en uso (cuenta `ContractInstalledItem.type`) → `DeviceTypeInUseError`. `OTROS` es no-borrable (fallback del pipeline).
- La **validación** pasa a ser dinámica: `ConfirmInventorySuggestion` y los guards de `contractInventory.routes.ts` validan contra el catálogo (lista cacheada en memoria, refrescada en cada mutación del catálogo) en vez del array hardcodeado. `normalizeQwenDeviceType` recibe el set válido por parámetro (se vuelve puro + inyectable). El prompt OCR (`OllamaDevicePhotoOcr`) inyecta los `name` del catálogo dinámicamente.
- **`classifyDeviceType` queda FUERA de scope de cambio de comportamiento**: su mapeo keyword→tipo (inferir tipo desde el texto de la pregunta IClass) sigue igual; solo se valida su salida contra el catálogo (desconocido → `OTROS`). Mover los keywords a la tabla es una mejora futura, no este cambio.

**F2 — Sub-page de configuración de inventario + dropdowns dinámicos [#6]**
- Nueva `InventorySettingsPage` (patrón `<Tabs>` lazy de `SchedulingSettingsPage`), primer tab **"Equipos"** = `DeviceTypesBody` (CRUD UI espejando `TaskPrioritiesBody`: tabla + modal create/edit + delete con confirm).
- Ruta nueva `/admin/inventory/settings` en `App.tsx` + child "Configuración" en el item Inventario del `Sidebar.tsx`.
- Nuevos `deviceTypes.api.ts` + `useDeviceTypes()` (+ mutations) en el FE.
- Los **dropdowns de tipo** de `SuggestionCard.tsx` y `ServiceInventorySection.tsx` dejan de usar el array `TYPES` hardcodeado y leen de `useDeviceTypes()`. `InstalledItemType` (union TS) pasa a `string`.

**F3 — Trazabilidad de "Revisado por inventario" [#3]**
- Migración aditiva: `ScheduledTask` gana `reviewedByInventoryAt DateTime?` + `reviewedByInventoryUserId String?` (FK a RbacUser, `onDelete: SetNull`).
- `SetTaskInventoryReview.execute(taskId, reviewed, actorId)` — al marcar setea `now()` + actor; al desmarcar limpia ambos. La route pasa `req.user.id`. El DTO de la tarea expone `reviewedByInventoryAt` + `reviewedByInventoryUserName` (resuelto por JOIN).
- FE: el `InventoryPanel` muestra, cuando `reviewedByInventory=true`, un badge **"✓ Revisado · {nombre} · {fecha}"** en vez del checkbox pelado.

### Permisos (decisión de diseño, se resuelve en spec/design)
- Lectura del catálogo + de la sub-page: `inventory.read` (YA existe).
- Escritura del catálogo (create/update/delete): **hay que crear** un permiso nuevo `inventory.manage` (hoy NO existe; el módulo inventory solo tiene `read`). Se crea el permiso RBAC + se otorga a `administrador` (espejo de `scheduling.manage` en `prisma/seed.ts`). Gating FE con `<Can permission="inventory.manage">`.

### Out of scope (cambios futuros)
- #1 — default de proyecto + descripción obligatoria en `CreateTaskModal` (otro dominio, cambio aparte).
- Mover los keywords de `classifyDeviceType` al catálogo (mejora futura).
- Iconos/colores por tipo de equipo en el catálogo (se puede agregar sin breaking change).
- Migrar los otros enums de inventario sueltos (`InventoryItemsPage`/`Products`/`CpePage` usan `'onu'` lowercase por su cuenta — deuda separada).

### Affected files (alto nivel)
- BE nuevos: `domain/entities/device-type-catalog.ts`, `domain/ports/DeviceTypeCatalogRepository.ts`, `infrastructure/adapters/{prisma,in-memory}/*DeviceTypeCatalogRepository.ts`, 5 use-cases, errores, DTO Zod, `infrastructure/http/routes/deviceTypeCatalog.routes.ts`.
- BE modificados: `prisma/schema.prisma` (+1 tabla, +2 columnas en ScheduledTask), 2 migraciones, `normalizeQwenDeviceType.ts`, `ConfirmInventorySuggestion.ts`, `contractInventory.routes.ts`, `OllamaDevicePhotoOcr.ts`, `SetTaskInventoryReview.ts` + su route, `device-type.ts`/`contract-installed-item.ts` (union → string), `app.ts` (DI), `prisma/seed.ts` (permiso inventory.manage).
- FE nuevos: `pages/inventory/InventorySettingsPage.tsx` (+css), `pages/inventory/settings/DeviceTypesBody.tsx` (+css), `api/deviceTypes.api.ts`, `hooks/useDeviceTypes.ts`, `types/deviceType.ts`.
- FE modificados: `App.tsx` (ruta), `Sidebar.tsx` (nav), `SuggestionCard.tsx` + `ServiceInventorySection.tsx` (dropdown dinámico), `types/serviceInventory.ts` (`InstalledItemType` → string), `TaskTabs.tsx` (InventoryPanel badge), `scheduling.api.ts` + tipos (reviewedBy fields).

### Risks & rollback
- **Riesgo bajo**: todas las migraciones son aditivas (tabla nueva + columnas nullable). Rollback = revertir PRs; los datos sembrados (5 tipos) son inertes si el código viejo vuelve (las columnas siguen siendo String).
- **Riesgo medio — validación dinámica**: si el catálogo queda vacío por error, confirmar inventario rechazaría todo. Mitigación: seed obligatorio de los 5 base + `OTROS` no-borrable + el guard cae a `OTROS` si el tipo no está (no rompe el flujo de cierre).
- **Orden de deploy**: BE primero (tabla + endpoints + seed del permiso), luego FE (consume el catálogo). El FE degrada con gracia si el endpoint no está (dropdown vacío → fallback a OTROS).
