# Prominense — API Externa (v1)

API máquina-a-máquina para integraciones externas (scripts, n8n, sistemas de terceros).
Autenticada por **API key** (token fijo del servidor). Es distinta de la API interna del panel,
que usa cookies de sesión + RBAC por usuario.

- **Base URL**: `https://<host>/api/external/v1`
- **Formato**: JSON. Toda respuesta de error usa el envelope `{ "error": "<mensaje>", "code": "<CODE>" }`.
- **Versión**: `v1`. Un cambio incompatible iría a `v2` (esta ruta se mantiene).

> Última actualización: 2026-07-18. Endpoints: `GET /clients`, `GET /clients/:id`,
> `GET /contracts`, `POST /tickets`, `POST /news`.

---

## Autenticación

Toda ruta bajo `/api/external/v1` exige la API key en **uno** de estos headers
(se prueba `X-API-Key` primero, si no `Authorization: Bearer`):

```
X-API-Key: <EXTERNAL_API_KEY>
```
```
Authorization: Bearer <EXTERNAL_API_KEY>
```

- La key vive en la env var **`EXTERNAL_API_KEY`** del servidor — **una sola key compartida** por todos los consumidores.
- Si el servidor **no** tiene `EXTERNAL_API_KEY` configurada → **toda** la API responde `401` (cerrada por defecto).
- Key ausente o incorrecta → `401 { "error": "Invalid or missing API key", "code": "UNAUTHORIZED" }`.
- Es auth máquina-a-máquina: **no hay sesión de usuario**. Los recursos que requieren un autor
  (tickets, noticias) se crean a nombre del usuario de sistema **`api`**.

> **Seguridad (deuda conocida)**: hoy es una única key sin scopes ni rotación por-consumidor.
> Quien tenga la key puede usar TODOS los endpoints. Migrar a API keys por-consumidor con permisos
> está en el backlog. Rotar = cambiar `EXTERNAL_API_KEY` y reiniciar el backend.

---

## Rate limiting

Los endpoints de **escritura** (`POST`) están limitados a **30 requests/minuto por IP**.
Al excederlo → `429 { "code": "RATE_LIMITED" }`. Como la key es compartida, el límite se aplica
por IP de origen. Los `GET` de lectura no tienen limiter.

---

## Endpoints de lectura

### `GET /clients` — listar clientes

| Query   | Tipo   | Default | Notas |
|---------|--------|---------|-------|
| `page`  | number | 1       | 1-based |
| `limit` | number | 25      | máximo 100 |
| `search`| string | —       | filtro por texto |
| `status`| string | —       | `ClientStatus` exacto |

`200`:
```json
{
  "data": [
    { "id": "...", "name": "...", "email": "...", "phone": "...", "status": "...",
      "address": "...", "city": "...", "country": "...", "createdAt": "..." }
  ],
  "total": 123, "page": 1, "limit": 25, "totalPages": 5
}
```
El DTO es una **allow-list**: excluye datos internos/de facturación (grClienteId, login, balances, customAttributes).

### `GET /clients/:id` — detalle de un cliente

`200`: un `ExternalClientDto` (mismo shape). `404 { "code": "CLIENT_NOT_FOUND" }` si no existe.

### `GET /contracts` — listar contratos

| Query        | Tipo   | Default | Notas |
|--------------|--------|---------|-------|
| `page`       | number | 1       | |
| `limit`      | number | 25      | máximo 100 |
| `search`     | string | —       | |
| `status`     | string | —       | estado canónico |
| `technology` | string | —       | matchea contra el valor ALMACENADO |

`200`:
```json
{
  "data": [
    { "id": "...", "code": "...", "clientId": "...", "plan": "...",
      "status": "...", "technology": "...", "startDate": "..." }
  ],
  "total": 42, "page": 1, "limit": 25, "totalPages": 2
}
```
`technology` es el valor EFECTIVO (manual si está seteado, si no derivado de la velocidad del plan).

---

## Endpoints de escritura

### `POST /tickets` — crear un ticket  *(rate-limited)*

Crea un ticket a nombre del usuario de sistema `api`. Valida FK cliente+contrato y ownership.

Body (JSON) — **todos requeridos**:

| Campo         | Tipo   | Reglas |
|---------------|--------|--------|
| `subject`     | string | ≤ 200 chars |
| `description` | string | ≤ 5000 chars |
| `customerId`  | string | ID del cliente |
| `contractId`  | string | ID del contrato (debe pertenecer al cliente) |
| `area`        | string | **nombre** del área (se resuelve contra el catálogo) |
| `priority`    | string | `low` \| `medium` \| `high` |

`201`:
```json
{
  "id": "...", "sequenceNumber": 1234, "subject": "...", "description": "...",
  "status": "...", "priority": "high", "customerId": "...", "contractId": "...",
  "areaName": "NOC", "createdAt": "..."
}
```

| Status | code | Cuándo |
|--------|------|--------|
| 400 | `VALIDATION_ERROR` | falta un campo, largo excedido, o `priority` inválida |
| 422 | `TICKET_AREA_NOT_FOUND` | el `area` (nombre) no existe |
| 422 | `CUSTOMER_NOT_FOUND` / `CONTRACT_NOT_FOUND` | FK inexistente |
| 422 | (mismatch) | el contrato no pertenece al cliente |
| 503 | `REPORTER_UNAVAILABLE` | el usuario de sistema `api` no está aprovisionado |
| 429 | `RATE_LIMITED` | superó el límite de escritura |

> **Tip**: el `area` selecciona el equipo destino — mandá `"NOC"` para que caiga en el área NOC.

---

### `POST /news` — crear una noticia  *(rate-limited)*

Crea una noticia en el tablón interno, a nombre del usuario de sistema `api`. Soporta **cuerpo en
Markdown**, **adjuntos de tipo link**, y **difusión opcional al canal NOC de WhatsApp** — el que usa
la API decide si difunde con el campo `sendToWhatsapp`.

Body (JSON):

| Campo            | Tipo    | Req. | Reglas |
|------------------|---------|------|--------|
| `title`          | string  | ✅   | 1..200 chars |
| `body`           | string  | ✅   | **Markdown**, 1..20000 chars |
| `category`       | string  | ✅   | **nombre** de la categoría (debe existir) |
| `pinned`         | boolean | —    | default `false` |
| `links`          | array   | —    | `[{ "url": "https://…", "title"?: "..." }]`; máx **20**; `url` debe ser `http(s)`; `title` es el rótulo del adjunto |
| `sendToWhatsapp` | boolean | —    | default `false`. Si `true`, difunde la noticia al canal NOC |

Ejemplo:
```json
{
  "title": "Corte programado zona Centro",
  "body": "## Mantenimiento\nEl **sábado 20/07** de 02:00 a 04:00 habrá corte por obra de fibra.",
  "category": "Red",
  "pinned": true,
  "links": [
    { "url": "https://status.prominense.com/incidents/42", "title": "Estado del incidente" }
  ],
  "sendToWhatsapp": true
}
```

Respuesta `201`:
```json
{
  "id": "...",
  "title": "Corte programado zona Centro",
  "category": "Red",
  "pinned": true,
  "publishedAt": "2026-07-18T12:00:00.000Z",
  "attachments": [
    { "id": "...", "kind": "link", "filename": "Estado del incidente",
      "mimeType": null, "sizeBytes": null, "url": "https://status.prominense.com/incidents/42",
      "fileUrl": null, "createdAt": "..." }
  ],
  "whatsapp": { "requested": true, "sent": true, "link": "https://<host>/admin/news?post=..." }
}
```
El DTO es allow-list: **no** expone `body`, `authorId`, `authorName`, `categoryId` ni campos internos.

**Campo `whatsapp`** (resultado de la difusión):

| Escenario | `whatsapp` |
|-----------|------------|
| `sendToWhatsapp: false` o ausente | `{ "requested": false, "sent": false }` |
| difusión exitosa | `{ "requested": true, "sent": true, "link": "<deep link>" }` |
| difusión falló (NOC caído/no configurado) | `{ "requested": true, "sent": false, "error": "<CODE>" }` |

> **Importante**: la difusión es **best-effort**. Si `sendToWhatsapp: true` y el envío falla
> (Evolution/NOC caído o sin configurar), la noticia **igual se crea** (respuesta `201`) y el fallo
> se reporta en `whatsapp.sent=false` + `whatsapp.error`. Un `201` no se cae por un canal lateral.
> Códigos posibles en `whatsapp.error`: `NOC_BROADCAST_NOT_CONFIGURED`, `EVOLUTION_API_ERROR`,
> `NOC_BROADCAST_LINK_BASE_MISSING`.

Errores (fallan el request):

| Status | code | Cuándo |
|--------|------|--------|
| 400 | `VALIDATION_ERROR` | falta `title`/`body`/`category`, largo excedido, `pinned`/`sendToWhatsapp` no-boolean, `links` no-array, o `link.url`/`link.title` no-string |
| 422 | `NEWS_CATEGORY_NOT_FOUND` | la `category` (nombre) no existe |
| 422 | `INVALID_LINK_ATTACHMENT` | un `url` no es `http(s)` |
| 422 | `TOO_MANY_NEWS_ATTACHMENTS` | más de 20 links |
| 503 | `REPORTER_UNAVAILABLE` | el usuario de sistema `api` no está aprovisionado |
| 429 | `RATE_LIMITED` | superó el límite de escritura |

> **No idempotente**: el endpoint no deduplica. Si el request falla con `500` (fallo de infra —
> ej. DB caída — a mitad de crear/adjuntar/difundir), la noticia puede haber quedado creada. Un
> reintento ciego puede duplicarla. Ante un `500`, verificá antes de reintentar. Los `4xx` sí son
> all-or-nothing (no crean nada).

> **Nota sobre adjuntos**: la API externa v1 acepta adjuntos de tipo **link** (referencian recursos
> por URL). La subida de **archivos binarios** (imágenes, PDF, `.md` como archivo) existe en el endpoint
> INTERNO del panel (`POST /api/news/:id/attachments`, multipart) y puede exponerse en la API externa
> como variante multipart si hace falta. Para contenido Markdown, va directo en el campo `body`.

---

## Webhooks (auth por FIRMA — NO por esta API key)

Aparte de la API con token, el sistema recibe **webhooks entrantes** autenticados por **firma HMAC**,
no por `EXTERNAL_API_KEY`:

- `POST /api/messaging/webhook` — Chatwoot (WhatsApp inbound). Firma HMAC-SHA256 sobre el cuerpo crudo
  con `CHATWOOT_WEBHOOK_SECRET`, ventana anti-replay ±5 min. `401 INVALID_SIGNATURE` / `401 STALE_TIMESTAMP`.

Las integraciones salientes (UISP, Orchestrator RADIUS, SmartOLT, Gigared, Gestión Real, Evolution/WhatsApp)
son clientes que **nosotros** llamamos con sus propios tokens — no exponen endpoints entrantes en esta API.

---

## Configurar un consumidor

1. Definí `EXTERNAL_API_KEY=<valor-secreto-largo>` en el `.env` del servidor.
2. Reiniciá el backend.
3. El consumidor manda la key en `X-API-Key` (o `Authorization: Bearer`).

Rotación: cambiá el valor y reiniciá (invalida la key anterior para todos los consumidores).

### `curl` de ejemplo — crear noticia + difundir al NOC

```bash
curl -X POST https://<host>/api/external/v1/news \
  -H "X-API-Key: $EXTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Corte programado zona Centro",
    "body": "## Mantenimiento\nSábado 02:00–04:00 por obra de fibra.",
    "category": "Red",
    "sendToWhatsapp": true
  }'
```
