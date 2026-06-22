# Proposal: Espejo de technology (por velocidad) + API externa GET contratos + Postman

## Intent
1. **Espejar `technology`** del contrato derivándola de la velocidad del plan (`< 100 Mbps → Wireless`, `>= 100 → Fiber`), reusando el `classifyTech` que YA existe — computed-on-read (la manual gana).
2. **`GET /api/external/v1/contracts`**: nuevo endpoint de la API externa (terceros) para listar contratos — calcado del de clientes.
3. **Postman**: colección de la API externa (clientes + contratos).

## Validado (explore)
- `classifyTech(plan: string) → 'FIBER'|'WIRELESS'|'UNCLASSIFIED'`: saca el primer int del plan, `>= 100 → FIBER`, `< 100 → WIRELESS`. Ya existe, sin tocar.
- Velocidad = `Contract.plan` (texto, ej. "300MB"/"50/25MB", siempre poblado por GR).
- Catálogo `ContractTechnology`: strings exactos `Fiber`/`Wireless`/`DOCSIS`/`FTTH`/`HFC`/`Radio`. **classifyTech devuelve MAYÚS → mapear** `FIBER→'Fiber'`, `WIRELESS→'Wireless'`.
- `technology` es Prominense-owned (GR no lo pisa). Default null.
- API externa: `externalV1.routes.ts` + `createApiKeyMiddleware` + DTO curado. `ListContracts({page,limit,search,status,technology}) → {data: ContractSummaryDto[], total, page, pageSize, totalPages}`.

## Scope (BE)

### 1. Espejo de technology (computed-on-read)
- Util `deriveTechnology(technology: string|null, plan: string|null): string|null` = `technology ?? mapClassify(classifyTech(plan))` donde `mapClassify`: FIBER→'Fiber', WIRELESS→'Wireless', UNCLASSIFIED→null.
- Aplicar en los DTOs de OUTPUT del contrato: `ContractSummaryDto` (ListContracts) + el DTO/mapper de `GetClientContracts` (lo que ve el FE) + el `ExternalContractDto` nuevo. El campo `technology` pasa a ser el efectivo (manual o derivado). La entity cruda mantiene el valor stored (para no romper filtros/lógica).
- NO migración, NO clobbering. (Backfill opcional = follow-up si se quiere filtrar por el valor derivado.)

### 2. API externa GET contratos
- `ExternalContractDto` (curado): `id, code, clientId, plan, status, technology (derivado), startDate, address, lat, lng, gpsLat, gpsLng, gpsPlusCode`. **EXCLUIR**: `type, ip, endDate, name, vendedor, services`.
- `toExternalContractDto(contract)` (proyector allow-list, future-field-safe, con la technology derivada).
- `GET /api/external/v1/contracts` (query `page, limit≤100, search, status, technology`) → `{data, total, page, limit, totalPages}`. Reusa `ListContracts`.
- Extender `createExternalV1Router(listClients, getClientDetail, listContracts)` + mount.

### 3. Postman
- `postman/IPNext-External-API.postman_collection.json`: colección con auth API-key (variable `{{api_key}}` + `{{base_url}}`), requests: GET clients (list + detail), GET contracts (list), con ejemplos + descripciones.

## Out of Scope
- Backfill del campo stored (follow-up). FE (el espejo en el DTO se muestra solo). Detalle externo de contrato `/:id` (después).

## Risks
| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Espejo pisa la tecnología manual | **Nula** | `technology ?? derived` — la manual gana |
| Filtro `?technology=` no matchea derivados | Media | el filtro es sobre el valor stored; documentar (backfill = follow-up para filtrar) |
| Casing del catálogo (FIBER vs Fiber) | Media | mapeo explícito en `mapClassify` + test |
| Plan sin número ("TV","Sin plan") | Baja | UNCLASSIFIED → null (no inventa tecnología) |
| Leak de datos sensibles en el DTO externo | Media | allow-list curado (excluye ip/vendedor/name/services); test de hygiene |

## Success Criteria
- [ ] El contrato muestra technology derivada del plan cuando no hay manual (Wireless/Fiber), la manual gana.
- [ ] `GET /api/external/v1/contracts` (API-key) → contratos curados con technology efectiva; sin key → 401.
- [ ] El DTO externo NO filtra ip/vendedor/name/services.
- [ ] Postman colección lista (clients + contracts).
- [ ] suite completa verde + tsc; review GO; verificación en vivo.
