# Design — external-create-ticket

## Contexto
La API externa (`/api/external/v1`, API-key M2M) era read-only (clientes #150, contratos #152).
Este change agrega la PRIMERA escritura: crear tickets. El desafío no es "exponer el endpoint"
sino adaptar un use case (`CreateTicket`) diseñado para el mundo CON sesión al mundo M2M.

## Decisiones

### D1 — Reusar `CreateTicket`, no reimplementar
El endpoint externo delega en el MISMO use case que el POST interno (`createTicket` instanciado
en `app.ts:912` con `customerLookup` + `contractLookup`). Así la validación FK + ownership corre
idéntica en ambos caminos — imposible que el externo cree un ticket cruzando clientes. El router
no reimplementa reglas de negocio.

### D2 — Reporter = usuario de sistema "api", resuelto server-side
La M2M no tiene `req.user`. El `reporterId` se resuelve por `rbacUserRepo.findByLogin('api')`
(mismo patrón que el GR ingest para tareas) y se estampa server-side. El body se lee campo por
campo POR NOMBRE (sin spread del body) → `reporterId`/`assigneeId`/`status`/`grCasoId` enviados
por el tercero se IGNORAN: no hay mass-assignment ni spoofing del autor.

### D3 — Desacople del bootstrap del reporter respecto de GR
`bootstrapApiUser` (#15) solo corría dentro de `bootstrapGestionRealIngest`, detrás de sus
early-returns (GR off → reporter inexistente). GR está en deprecación. Se extrae a un
composition-root nombrado `bootstrapSystemUsers` que `main.ts` invoca INCONDICIONAL y con `await`
ANTES de `createApp` — garantiza que el reporter existe antes de aceptar requests. El GR ingest
deja de sembrarlo (lo resuelve por login en runtime; corre fire-and-forget DESPUÉS del listen,
cuando main ya lo creó). Alternativa descartada: bootstrap lazy on-demand en el endpoint (menos
claro, latencia en el primer request, y no cubre al GR ingest).

### D4 — Área por NOMBRE (no por id); priority validada contra el enum
El tercero no conoce los ids internos del catálogo de áreas → manda el NOMBRE, resuelto con
`ticketAreaRepo.getByName` (case-insensitive en el adapter) → 422 si no existe. `priority` es el
enum fijo `TicketPriority` (`low|medium|high`) → validación estricta contra la lista, 400 si es
inválida (a diferencia del POST interno, que coacciona silenciosamente a `medium` — el externo es
más estricto a propósito).

### D5 — DTO curado (allow-list, future-field-safe)
`toExternalTicketDto` es un proyector explícito: solo `id, sequenceNumber, subject, description,
status, priority, customerId, contractId, areaName, createdAt`. Excluye PII de admins internos
(`reporterName`/`assigneeName`), ids internos (`reporterId`/`assigneeId`/`areaId`), `grCasoId`,
`areaColor`, `customerName`, y campos de estado interno. Campos futuros del entity NO se incluyen
automáticamente.

### D6 — Rate-limiter dedicado al POST
La API-key pasa de read-only a read+write → una escritura pública sin techo es abuso (creación
masiva). `createExternalWriteRateLimiter` (por IP, 30/min) se aplica SOLO al POST `/tickets`
(spread condicional de middleware), sin tocar los GET en prod. Keyea por IP porque hay UNA sola
key compartida (per-consumer keying es imposible hoy). `trust proxy` ya está seteado en `app.ts`
→ `req.ip` es el cliente real.

### D7 — Params opcionales + composition-root test (anti-W6)
Los `ticketDeps` son opcionales en el router (para que los tests in-memory monten sin todo el
stack). Riesgo: si `app.ts` no los pasa, el endpoint desaparece en prod sin error de compilación
(bug W6). Mitigación: composition-root test que pinea que el mount pasa los deps, y que el
bootstrap del reporter es incondicional.

## Deudas (fuera de este change)
- `[MEDIA]` `main.ts` bootstrap fail-silent (no `process.exit(1)`) — HEREDADO del `await
  configRepo.get()` preexistente; no lo empeora este cambio. Card aparte.
- `[LOW]` API-key comparison no constant-time (`apiKeyMiddleware`, hardening global).
- `[LOW]` `getByName` no determinístico ante áreas duplicadas case-variant (`name @unique` es
  case-sensitive en PG).
- Per-consumer API keys / scopes (ya en la card "API Externa — el mapa").
