# Exploration: tv-gigared-integration (#47)

## Goal
Integrar la API de Gigared Partners (TV/OTT para revendedores) en el panel Prominense. Cuatro vectores: config con API Key (Settings), activación por cliente (CustomerDetailPage), página de clientes TV actuales (CRM), y catálogo de servicios (ContractService#TV).

---

## API Summary (Gigared Partners v1.0.0)

| Endpoint | Descripción |
|----------|-------------|
| GET /health/live | Liveness, sin auth |
| GET /partners/summary | Resumen partner: cuentas registradas + catálogo de servicios con qty_available/used/purchased |
| GET /partners/internal_ids | Lista todos los internal_ids registrados |
| GET /accounts | Lista paginada con filtros (email, status, services, pagination_limit/offset) |
| GET /accounts/{cic} | Detalle de cuenta — crm{cic, gigared_id, email, nombre, services[]}, internal_id, ott{id, licencias, status} |
| POST /accounts/register | Registrar nueva cuenta (first_name, last_name, email, cic, password, send_activation_email) |
| POST /accounts/activate | Activar cuenta registrada |
| PATCH /accounts/{cic}/internal_id | Asociar nuestro ID al CIC |
| PATCH /accounts/{account_id} | Actualizar email/nombre/password |
| PUT /accounts/{account_id}/renew | Renovar CIC (old_cic → new_cic, internal_id migra solo) |
| GET/POST/DELETE /services/{account_id} | Listar, asignar y remover servicios a una cuenta |
| PUT /ott/{account_id}/enable\|disable | Habilitar/deshabilitar OTT |

**Auth**: header `X-API-Key`. **Rate limit**: 429 + Retry-After. **Errores**: RFC 9457 (`status`, `type`, `title`, `detail`). El `account_id` puede ser CIC o internal_id (con `?use_internal_id=true`).

---

## Current State

### Adapters existentes

| Adapter | Auth | Retry/429 | Token storage |
|---------|------|-----------|---------------|
| **UispClient** (`src/infrastructure/adapters/uisp/UispClient.ts`) | Header `x-auth-token` | No retry explícito — UispUnavailableError | Env: `UISP_TOKEN` + `UISP_BASE_URL` en `config.ts:117-120` |
| **IClassClient** (`src/infrastructure/adapters/iclass/IClassClient.ts`) | Bearer token con re-login 401 + retry 429 exponencial | `withAuthRetry` con `Retry-After` + backoff exponencial, hasta `MAX_RATE_LIMIT_RETRIES=4` | Env: `ICLASS_USERNAME`, `ICLASS_PASSWORD`, etc. |
| **GestionRealClient** (`src/infrastructure/adapters/gestion-real/GestionRealClient.ts`) | Basic Auth rotativo diario (MD5) | No retry | Env: `GR_CUIT`, `GR_SECRET` |

### Config singleton pattern

Tanto `GestionRealSyncConfig` como `IClassClosureConfig` usan:
- Port en `src/domain/ports/` → interface `{ get(): Promise<T>; update(patch: Partial<T>): Promise<T> }`
- `PrismaXxxConfigRepository` con tabla single-row, `SINGLETON_ID = 'singleton'`, defaults hardcoded, `upsert` en `update()`
- NO almacenan credenciales en DB — solo parámetros operativos (intervalMs, etc.)
- Las **credenciales** (secrets) siempre viven en **env** (`config.ts`)

### RBAC pattern (UISP como modelo)

Migración `20260619000000_uisp_mirror/migration.sql`:
1. `INSERT INTO "RbacModule"` → nuevo módulo `uisp`
2. `INSERT INTO "RbacPermission"` → `uisp:read`, `uisp:manage`
3. `INSERT INTO "RbacRolePermission"` → `super_admin` recibe ambos
4. `INSERT INTO "FeatureFlag"` → `uisp-sync` default OFF

### FE: Dónde vive cada cosa

| Elemento | Archivo / Ruta |
|----------|----------------|
| CRM routes | `src/App.tsx:300-305` → `/admin/crm/{leads,dashboard,quotes,map}` (permiso `crm.read`) |
| CustomerDetailPage tabs | `src/pages/customers/CustomerDetailPage.tsx:23` → array `TAB_IDS`, tabs definidos en líneas ~92-154 |
| Customers Settings | `src/pages/customers/CustomersSettingsPage.tsx` → Tabs con `GestionRealSyncBody` y `ServiceTechnologiesBody` |
| Networking Settings | `src/pages/networking/NetworkingSettingsPage.tsx` → secciones UISP, Mapeo de nodos, Nodos UISP |
| Integraciones tab (global) | `src/pages/system/SettingsPage.tsx:2194` → `IntegracionesTab()` con cards de Stripe, AFIP, SendGrid, etc. |

### ServiceCatalog: 'TV' ya seedeado

Migración `20260626000000_service_catalog/migration.sql:22`:
```sql
(gen_random_uuid(),'TV', true, 1, now(), now())
```
El modelo `ContractService` (#43) ya tiene la relación con `ServiceCatalog`. Los specs en `openspec/specs/contract-services/spec.md` no mencionan metadata externa futura — `notes` es el campo libre disponible hoy.

---

## Affected Areas

- `src/infrastructure/adapters/gigared/GigaredClient.ts` — **NUEVO** — adapter X-API-Key con retry 429
- `src/domain/ports/GigaredPort.ts` — **NUEVO** — port interface (listAccounts, getAccount, register, activate, setInternalId, addService, removeService, enableOtt, disableOtt)
- `src/domain/errors/gigared.ts` — **NUEVO** — GigaredUnavailableError, GigaredRejectedError
- `src/domain/ports/GigaredConfigRepository.ts` — **NUEVO** — singleton config (apiKey, enabled, baseUrl opcional)
- `src/infrastructure/adapters/prisma/PrismaGigaredConfigRepository.ts` — **NUEVO**
- `src/infrastructure/adapters/in-memory/InMemoryGigaredConfigRepository.ts` — **NUEVO**
- `prisma/schema.prisma` — **GigaredConfig** single-row table
- `prisma/migrations/` — migración con tabla + módulo RBAC `tv` + FeatureFlag `gigared-integration`
- `src/infrastructure/config.ts` — sin cambio (API key va a DB, no a env — ver decisión abajo)
- `src/infrastructure/http/app.ts` — wiring DI del router Gigared
- `src/infrastructure/http/routes/gigared.routes.ts` — **NUEVO**
- `src/application/use-cases/gigared/` — **NUEVO** (GetGigaredAccounts, GetGigaredAccount, ConfigureGigared, RegisterGigaredAccount, SetGigaredInternalId, etc.)
- FE: `src/pages/crm/` — nueva page `GigaredAccountsPage.tsx` + ruta `/admin/crm/tv`
- FE: `src/pages/customers/tabs/TvTab.tsx` — **NUEVA** — activación por cliente
- FE: `CustomerDetailPage.tsx` — agregar tab 'tv' gateado por `tv.read`
- FE: `src/pages/customers/CustomersSettingsPage.tsx` — nuevo tab `GigaredConfigBody` (API Key input)

---

## Integration Pattern Decision

### Patrón elegido: UispClient-style (más cercano)

Gigared usa autenticación simple por header (X-API-Key) — exactamente como UISP usa `x-auth-token`. No hay login/refresh de token como IClass.

**Diferencias vs UISP**:
1. UISP usa `x-auth-token`, Gigared usa `X-API-Key` — cambio trivial
2. UISP no tiene retry 429 explícito; Gigared tiene rate limiting documentado → copiar el `withRetry429` de IClassClient (es más limpio y ya fue probado en prod)
3. UISP no tiene cert self-signed issue → no necesitar `rejectUnauthorized: false`

**Template final del adapter**: Base UispClient + bloque retry-429 de IClassClient.

```typescript
// src/infrastructure/adapters/gigared/GigaredClient.ts
class GigaredClient implements GigaredPort {
  constructor(private opts: { baseUrl: string; apiKey: string; timeoutMs?: number; http?: AxiosInstance }) { ... }
  
  private async withRetry429<T>(fn: () => Promise<{ data: T }>): Promise<T> { /* copiado de IClass */ }
  private headers() { return { 'X-API-Key': this.opts.apiKey }; }
  // listAccounts(params), getAccount(cic), etc.
}
```

---

## Config / Secret Strategy: API Key en DB (no en env)

**El usuario quiere configurar la API Key desde la UI**. Esto determina la estrategia:

| Estrategia | Pros | Contras |
|------------|------|---------|
| **DB-backed (elegida)** — `GigaredConfig` singleton con `apiKey TEXT` en tabla | UI editable, degradación elegante si `apiKey` es vacío, cero restart | API key visible en DB (riesgo menor en infra interna ISP); la UI debe enmascarar el campo |
| Env var (`GIGARED_API_KEY`) | Secreto fuera de DB | Requiere restart para cambiar, no editable desde UI |
| Env para secret + DB para resto | Separación clara | Split cognitivo, pero GR ya almacena `cuit`/`secret` en env; inconsistente con el requerimiento de UI-editable |

**Decisión**: `GigaredConfig` en DB. `apiKey` en campo `TEXT` (como GR guarda `secret` en env pero acá es el requerimiento que sea UI-configurable). La UI muestra `type="password"` con máscara (readonly salvo que el usuario haga click en "editar"). El adapter se instancia con `apiKey = ''` si la config no tiene key → todos los endpoints responden 503 con mensaje "Configurá la API Key en CRM → Configuración".

**Degradación elegante**: El use case `GetGigaredAccounts` verifica que `config.apiKey !== ''` antes de llamar al adapter; si está vacío lanza `GigaredNotConfiguredError` → route devuelve 503 con `{ code: 'GIGARED_NOT_CONFIGURED' }`. El FE muestra un banner.

---

## Mirror vs On-Demand Decision

| Opción | Pros | Contras |
|--------|------|---------|
| **On-demand con cache (elegida)** | Simple, sin tabla extra, datos frescos al paginar | Latencia visible en la page TV; rate-limit 429 si muchos usuarios cargan simultáneamente |
| Mirror local (como UISP) | Búsqueda instantánea, sin latencia, pagination local | Tabla `GigaredAccount` nueva, scheduler 5-min, complejidad de sync, posible drift |

**Recomendación: on-demand para V1**. La page de "clientes TV actuales" hace GET /accounts con paginación directa a la API Gigared, con retry-429 en el adapter. El BE actúa como proxy (agrega auth, transforma RFC 9457 errors, aplica permisos RBAC). Si en el futuro el volumen o el rate limit lo justifican, el mirror es un upgrade incremental (nueva migración + scheduler).

---

## Customer ↔ CIC Mapping (internal_id strategy)

Gigared provee `internal_id` = nuestro ID asociable. La estrategia:

1. Cuando se activa TV para un cliente, el use case llama a `PATCH /accounts/{cic}/internal_id` con `{ internal_id: customer.id }` (UUID del Customer en nuestra DB)
2. Luego, para buscar la cuenta de un cliente: `GET /accounts/{customer.id}?use_internal_id=true`
3. El CIC no se almacena en nuestra DB en V1 — siempre se consulta vía `internal_id`. Si la API Gigared está caída, la solapa TV del cliente muestra "No disponible temporalmente"
4. Para V2 podría agregarse `cicGigared TEXT?` al modelo `Customer` si se necesita lookup inverso offline

**Campo en ContractService**: cuando se agrega el ítem TV al contrato (POST /contracts/:id/services con `serviceCatalogId = <id del TV>`), el `notes` field puede usarse para guardar el CIC de Gigared (`"CIC: 0000002354"`). Esto es suficiente para V1 sin tocar el schema.

---

## FE Locations

### 1. Config de API Key
**Ubicación**: `src/pages/customers/CustomersSettingsPage.tsx` → nuevo tab `gigared` dentro del `Tabs`
- Patrón: igual que `GestionRealSyncBody` — componente `GigaredConfigBody.tsx` en `src/pages/customers/settings/`
- Campo: input `type="password"` para la API Key + botón "Verificar conexión" (GET /health/live + GET /partners/summary)
- Permiso: `clients.read` (misma page) + `clients.write` para guardar

### 2. Page de clientes TV actuales
**Ubicación**: nueva ruta `/admin/crm/tv` → `src/pages/crm/GigaredAccountsPage.tsx`
- App.tsx línea ~305: agregar `<Route path="tv" element={<RequirePermission permission="tv.read"><GigaredAccountsPage /></RequirePermission>} />`
- Tabla con paginación, columnas: CIC, nombre, email, servicios activos, estado OTT
- Filtros: email, status (registered/unregistered)
- Banner de "API Key no configurada" si el BE devuelve 503

### 3. Solapa TV en CustomerDetailPage
**Ubicación**: `src/pages/customers/CustomerDetailPage.tsx` + nuevo `src/pages/customers/tabs/TvTab.tsx`
- Agregar a `TAB_IDS` y al array `tabs[]`, gateado por `useCan('tv.read')`
- TvTab muestra: estado de cuenta Gigared (CIC, servicios, OTT status), botones "Activar TV", "Agregar servicio", "Habilitar/deshabilitar OTT"
- El tab se monta lazy (patrón `activatedTabs.current.has('tv')`)

---

## Permissions: New RBAC Module `tv`

Patrón UISP:
```sql
-- RbacModule: 'tv', label 'TV / Gigared'
-- RbacPermission: tv:read, tv:manage
-- Grant super_admin: tv:read + tv:manage
-- FeatureFlag: 'gigared-integration' (default OFF)
```

---

## Risks

1. **Rate limit 429 en page TV paginada**: si muchos operadores cargan la page simultáneamente, las requests al adapter se acumulan. Mitigación: retry-429 con Retry-After, y documentar que es on-demand.
2. **API Key en DB plano**: no hay encriptación en reposo. Riesgo menor para infra interna de ISP, pero hay que documentarlo. Si el cliente lo pide → usar `pgcrypto` en una iteración posterior.
3. **CIC requerido para registro**: el use case de "activar TV" requiere que el operador ingrese o busque el CIC de Gigared. No hay lookup CIC por nombre desde la API (solo por email/status). El operador debe conocer el CIC de antemano. Mitigación: el campo de búsqueda en TvTab puede filtrar por email en GET /accounts.
4. **`notes` en ContractService como campo de CIC**: es un string libre, sin validación. Si en el futuro se quiere procesarlo, hay que migrar a un campo dedicado. Riesgo bajo para V1.
5. **La API Gigared está caída durante activación**: el use case debe manejar `GigaredUnavailableError` y retornar 503 sin dejar el ContractService en estado inconsistente (primero crear el ContractService local, luego llamar a Gigared — o al revés, y si Gigared falla el ContractService no se crea).

---

## Open Questions

1. **¿La activación TV requiere que el cliente ya tenga CIC en Gigared** (registro previo) **o el operador lo registra desde la UI?** → Impacta si implementamos el flow `POST /accounts/register` en V1 o solo `GET` y `PATCH /internal_id`.
2. **¿El CIC es visible en los datos del cliente en Prominense** (importado de Splynx/GR)? → Si ya viene en el mirror de clientes, el lookup automático es posible.
3. **Orden de operaciones al activar**: ¿primero creamos el ContractService (TV) y luego asociamos el CIC? ¿O viceversa? ¿Qué pasa si Gigared falla a mitad del flow?
4. **¿Se necesita el flow completo** (register + activate + addService) **o solo el binding** (set internal_id + addService a una cuenta que ya existe en Gigared)?

---

## Ready for Proposal

**Sí**. El patrón de integración está claro: GigaredClient (UispClient-style + retry-429), config DB-backed (`GigaredConfig` singleton), on-demand proxy para la page TV, `internal_id = customer.id` como mapping. Quedan las 4 preguntas abiertas para el proposal (son scope decisions, no blockers arquitecturales).
