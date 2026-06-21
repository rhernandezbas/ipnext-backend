# Proposal: API Externa v1 — GET clientes (read-only, API-key)

## Intent
Primer endpoint de una **API EXTERNA** (pública, para terceros) de Prominense, separada de la API interna FE↔BE. Arranca exponiendo **clientes** (read-only GET) con sus datos + dirección. Se va a ir armando el mapa (`/api/external/v1/...`) para exponer el resto después (contratos, etc.).

## Why
La API actual es interna (cookie JWT + CORS lockeado al FE). No sirve para que la consuma un sistema externo. Esta capa nueva usa **API-key** (máquina-a-máquina), namespace versionado, y un DTO **curado** (sin datos internos/sensibles).

## Scope (BE-only, read-only)

### Auth nueva (API-key, NO cookie)
- `src/infrastructure/http/middleware/apiKeyMiddleware.ts`: `createApiKeyMiddleware()` — lee `X-API-Key` o `Authorization: Bearer <key>`, valida contra `config.externalApi.apiKey`. 401 si falta/no matchea o si la key no está configurada. NO setea `req.user`.
- `config.ts`: `externalApi: { apiKey: process.env.EXTERNAL_API_KEY ?? '' }` (opt-in, sin fail-fast — patrón iclass/uisp). Agregar a `env.example`.
- **API-key**: una sola key compartida (env) para el MVP. Per-consumer keys (tabla) = mejora futura.

### Router externo (reusa use cases, NO reinventa)
- `src/infrastructure/http/routes/externalV1.routes.ts`: `createExternalV1Router(listClients, getClientDetail)`.
  - `GET /clients` → `ListClients.execute({ page, limit, search, status })` → `{ data: ExternalClientDto[], total, page, limit, totalPages }`.
  - `GET /clients/:id` → `GetClientDetail.execute(id)` (string UUID) → `ExternalClientDto` (404 si no existe).
- Montaje en `app.ts`: `app.use('/api/external/v1', createApiKeyMiddleware(), createExternalV1Router(listClients, getDetail))` (los use cases ya están instanciados — cero wiring nuevo de repos).

### DTO curado (hygiene)
- `ExternalClientDto`: `{ id, name, email, phone, status, address, city, country, createdAt }`. Proyector dedicado `toExternalClientDto(customer)`.
- **EXCLUIR** (sensible/interno): `grClienteId`, `login` (Splynx), `customAttributes`, `balanceDue/balanceCurrency/lastBalanceAt/balanceStale`, cualquier id de mirror.

## Out of Scope (la "demás" — después)
- Contratos, facturas, OS, etc. (próximos endpoints del mapa). Direcciones de instalación (viven en Contract con lat/lng) → cuando se exponga contratos.
- Per-consumer API keys, rate-limiting, OpenAPI doc (mejoras siguientes).
- Escrituras (es read-only).

## Affected Areas
| Área | Impacto |
|------|---------|
| `middleware/apiKeyMiddleware.ts` | NEW |
| `routes/externalV1.routes.ts` | NEW (router + ExternalClientDto + proyector) |
| `config.ts` + `env.example` | +`externalApi.apiKey` (EXTERNAL_API_KEY) |
| `http/app.ts` | montar el router bajo `/api/external/v1` |
| `.github/workflows/deploy.yml` | +`-e EXTERNAL_API_KEY="${{ secrets.EXTERNAL_API_KEY }}"` |

## Risks
| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Filtrar datos sensibles | Media | DTO curado + proyector dedicado (NO reusar toCustomer crudo); test que verifica que NO salen login/balance/etc. |
| Key vacía → API abierta | Baja | middleware 401 si `config.apiKey` vacío (no expone nada sin key configurada) |
| `GetClientDetail` dispara refresh GR en clientes `late` | Baja | transparente (mismo shape); el DTO excluye balance igual |
| id es UUID string (no number) | Baja | pasar `req.params.id` como string directo |

## Success Criteria
- [ ] `GET /api/external/v1/clients` (con API-key) → lista paginada de clientes con DTO curado.
- [ ] `GET /api/external/v1/clients/:id` → un cliente (404 si no existe).
- [ ] Sin API-key / key inválida → 401.
- [ ] El DTO NO incluye login/grClienteId/balance/customAttributes.
- [ ] suite completa verde + tsc; review GO; verificación en vivo.
