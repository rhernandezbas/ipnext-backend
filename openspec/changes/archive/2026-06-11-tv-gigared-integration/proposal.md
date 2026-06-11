# Proposal: TV Gigared Integration (#47)

## Intent

Integrar la API Gigared Partners (TV/OTT) en Prominense: configurar la integración desde la UI, activar TV por cliente (vinculando o registrando su cuenta Gigared y agregando el ítem TV al contrato vía catálogo #43), y ver los clientes TV del partner en CRM. La API key llega después → degradación amable sin key.

## Scope

### In Scope
- BE: adapter `GigaredClient` (X-API-Key, retry-429 estilo IClass, errores RFC 9457 mapeados) + port `GigaredPort` en domain.
- BE: `GigaredConfig` singleton DB-backed (apiKey UI-editable, enmascarada en GET: `configured` + últimos 4) + repo Prisma/in-memory.
- BE: use cases `GetGigaredSummary`, `ListGigaredAccounts`, `GetGigaredAccount` (by internal_id = customer.id), `LinkCustomerToCic`, `RegisterGigaredAccount` (password server-side NO persistida + activate), `AddTvService` (+`ContractService` TV local, notes `"CIC {cic} · {serviceName}"`), `RemoveTvService`, `SetOttStatus`, get/update config.
- BE: router `/api/gigared/*` con guards RBAC; sin key o flag OFF → 503 `GIGARED_NOT_CONFIGURED`.
- Migración: tabla `GigaredConfig` + módulo RBAC `tv` (tv:read/write/manage, grants a super_admin + administrador) + FeatureFlag `gigared-integration` OFF. Aditiva, sin BEGIN/COMMIT.
- FE: page `/admin/crm/tv` (`GigaredAccountsPage`, proxy paginado on-demand, filtros email/status, banner 503 accionable) · tab TV lazy en `CustomerDetailPage` (ambos flujos: vincular CIC o registrar; servicios add/remove; OTT on/off) · tab "Gigared TV" en `CustomersSettingsPage` (tv.manage).

### Out of Scope
- Mirror local de cuentas (V1 es on-demand) · webhooks · renew CIC desde UI · rotación de API keys desde UI (la API lo soporta, V2) · persistir CIC en nuestra DB.

## Capabilities

### New Capabilities
- `gigared-config`: config singleton (apiKey enmascarada, baseUrl, verificación de conexión) + feature flag + 503 sin configurar.
- `gigared-accounts`: proxy on-demand de cuentas del partner (lista paginada/filtrada, summary con qty_available).
- `gigared-customer-tv`: activación TV por cliente — link/register, servicios (+ContractService local), OTT.

### Modified Capabilities
- None (`contract-services` se consume tal cual; RBAC/flags siguen su patrón).

## Approach

Adapter UispClient-style + retry-429 de IClass; use cases dependen de `GigaredPort` y `GigaredConfigRepository` (DIP). Binding cliente↔Gigared vive en Gigared (`internal_id = customer.id`); lookup `GET /accounts/{customer.id}?use_internal_id=true`. Orden de activación: 1º Gigared add service, 2º ContractService local; si lo local falla → 207 + retry manual (sin transacción distribuida, documentado).

### Wire contract (sketch)
```
GET/PUT  /api/gigared/config                              tv.manage
GET      /api/gigared/summary | /accounts?email&status&…  tv.read
GET      /api/gigared/customers/:id/account               tv.read
POST     /api/gigared/customers/:id/link {cic}            tv.write
POST     /api/gigared/customers/:id/register {…, cic}     tv.write
POST     /api/gigared/customers/:id/services {serviceId}  tv.write  → 200|207
DELETE   /api/gigared/customers/:id/services/:serviceId   tv.write
PUT      /api/gigared/customers/:id/ott {enabled}         tv.write
```

## Affected Areas

| Area | Impact |
|------|--------|
| `src/domain/ports/GigaredPort.ts`, `GigaredConfigRepository.ts`, `src/domain/errors/gigared.ts` | New |
| `src/infrastructure/adapters/gigared/GigaredClient.ts` + repos Prisma/in-memory | New |
| `src/application/use-cases/gigared/*` | New |
| `src/infrastructure/http/routes/gigared.routes.ts`, `app.ts` | New/Modified |
| `prisma/schema.prisma` + migración | Modified |
| FE: `GigaredAccountsPage`, `TvTab`, `GigaredConfigBody`, `App.tsx`, `CustomerDetailPage` | New/Modified |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Gigared OK + ContractService local falla | Med | 207 + retry manual; notes con CIC |
| 429 en page on-demand | Med | retry-429 con Retry-After |
| API key plana en DB | Low | enmascarada en GET; pgcrypto V2 |
| Sin CIC persistido, API caída = tab vacío | Med | mensaje "no disponible", reintento |

## Rollback Plan

Flag `gigared-integration` OFF = kill switch inmediato (routes 503, FE oculta superficies). Revert de código vía PR; la migración aditiva queda inerte (tabla/permisos sin uso).

## Dependencies

- API key del Ejecutivo de Cuentas Gigared (post-deploy) · catálogo TV ya seedeado (#43).

## Success Criteria

- [ ] Sin key/flag OFF: 503 `GIGARED_NOT_CONFIGURED` + banner FE accionable, nada roto.
- [ ] Con key: operador vincula o registra cuenta, agrega servicio TV y aparece `ContractService` TV con CIC en notes.
- [ ] Page `/admin/crm/tv` lista cuentas del partner con filtros y paginación (tv.read).
- [ ] Permisos: roles sin grant no ven superficies TV; super_admin + administrador sí.

## Post-deploy

Cargar API key en Settings → Gigared TV → verificar conexión (health + summary) → prender flag → smoke en page TV.
