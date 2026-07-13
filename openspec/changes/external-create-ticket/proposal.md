# Proposal: API Externa v1 — POST tickets (primera ESCRITURA, API-key) + desacople del reporter "api" de GR

## Intent
Primer endpoint de ESCRITURA de la API externa (M2M): `POST /api/external/v1/tickets`. Un sistema de un tercero crea tickets en Prominense con la API-key existente. Hasta hoy la API externa era read-only (clientes #150, contratos #152). Como efecto secundario NECESARIO, se DESACOPLA el bootstrap del usuario de sistema "api" (el reporter de registros creados por máquina) de Gestión Real, que está en deprecación.

## Why
- Un tercero necesita abrir tickets sin sesión de usuario. La única superficie sin cookie es `/api/external/v1` (API-key, M2M).
- `CreateTicket` ya existe pero fue diseñado para el mundo CON sesión: `reporterId` se estampa desde `req.user.id`, `areaId` es obligatorio, valida FK+ownership de customer/contract. La M2M no tiene sesión → hay que resolver reporter/área sin usuario.
- El reporter de máquina (usuario "api", #15) hoy SOLO se crea dentro de `bootstrapGestionRealIngest`, detrás de 2 early-returns (GR disabled / sin creds). Con GR EN DEPRECACIÓN, atar el reporter al ciclo de vida de GR es una bomba de tiempo: el día que GR se apague, el endpoint externo se queda sin reporter (503/huérfano).

## Scope (BE-only)

### T1 — Desacople del reporter "api" de GR
- `src/infrastructure/bootstrap/bootstrapSystemUsers.ts` (NEW): composition-root nombrado que garantiza el usuario "api" (reusa `bootstrapApiUser`, idempotente). Repo + passwordHash inyectados (testeable con in-memory).
- `main.ts`: `await bootstrapSystemUsers(...)` INCONDICIONAL, ANTES de `createApp` (el reporter existe antes de servir requests).
- `bootstrapGestionRealIngest.ts`: deja de sembrar el usuario "api" (lo resuelve por login en runtime; main ya lo garantizó antes del listen).

### T2 — Endpoint POST /tickets
- `externalV1.routes.ts`: `POST /tickets` (montado solo si `ticketDeps` presente). Lee `subject, description, customerId, contractId, area (nombre), priority` del body POR NOMBRE (sin spread → no spoofeable). Resuelve área por nombre (`getByName`), reporter por login ("api"), delega a `CreateTicket`. Respuesta = DTO curado `ExternalTicketDto`.

### T3 — Wiring + rate-limiter
- `rateLimiters.ts`: `createExternalWriteRateLimiter()` (por IP, 30/min) dedicado al POST.
- `app.ts`: pasa `{ createTicket, rbacUserRepo, ticketAreaRepo, rateLimiter }` (instancias existentes — cero wiring nuevo de repos).

## Out of Scope
- Per-consumer API keys / scopes (sigue 1 key compartida — deuda de "el mapa").
- Rate-limit sobre los GET existentes (no se tocan, no romper #150/#152).
- Otras escrituras externas (update/close de tickets).
- `process.exit(1)` en el fail de bootstrap de main (deuda HEREDADA del `await configRepo.get()` preexistente — card aparte).

## Affected Areas
| Área | Impacto |
|------|---------|
| `bootstrap/bootstrapSystemUsers.ts` | NEW |
| `main.ts` | +bootstrap incondicional del reporter (antes de createApp) |
| `scheduling/bootstrapGestionRealIngest.ts` | -bootstrap del api user (desacople) |
| `routes/externalV1.routes.ts` | +ExternalTicketDto + proyector + POST /tickets |
| `middleware/rateLimiters.ts` | +createExternalWriteRateLimiter |
| `http/app.ts` | wiring de ticketDeps al router externo |

## Risks
| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Filtrar datos internos en el DTO | Media | allow-list + proyector dedicado; test de hygiene (no reporterId/grCasoId/customerName/assignee) |
| Spoofing del reporter/assignee vía body | Media | body leído POR NOMBRE (sin spread); reporterId forzado server-side |
| Ownership bypass (contrato ajeno) | Media | reusa `CreateTicket` con customerLookup+contractLookup → 422 |
| Escritura pública sin techo | Media | rate-limiter dedicado al POST (por IP) |
| Reporter no existe (GR off) | Alta (a futuro) | DESACOPLE: bootstrap incondicional en main |
| Endpoint no montado en prod (bug W6) | Media | composition-root test del wiring |

## Success Criteria
- [x] `POST /api/external/v1/tickets` (con API-key) crea ticket → 201 DTO curado; reporter = usuario "api".
- [x] 422 customer/contract inexistente + ownership; 422 área fuera de catálogo; 400 priority/required/largo.
- [x] Sin API-key → 401.
- [x] DTO NO expone reporterId/grCasoId/customerName/assignee/areaColor.
- [x] Usuario "api" bootstrappeado incondicional (GR off no lo afecta).
- [x] Rate-limiter dedicado al POST (GET intactos).
- [x] suite completa verde + tsc; review adversarial 0 CRITICAL/0 HIGH.
