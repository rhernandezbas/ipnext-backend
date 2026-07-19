# Prominense — API de Noticias (externa) · Guía de uso

Endpoint para **crear noticias** desde un sistema externo (script, n8n, otro backend),
autenticado por **API key**. Soporta cuerpo en **Markdown**, **adjuntos** (links y archivos)
y **difusión opcional al canal de WhatsApp del NOC**.

- **Método / ruta**: `POST /api/external/v1/news`
- **Host**: el del panel/BE (ej. `http://190.7.234.37:7778` o tu dominio) → `https://<host>/api/external/v1/news`
- **Auth**: API key en header (ver abajo)
- **Rate limit**: 30 requests / minuto por IP → excederlo = `429 RATE_LIMITED`

---

## 1. Autenticación

Mandá la key en **uno** de estos headers (se prueba `X-API-Key` primero):

```
X-API-Key: <EXTERNAL_API_KEY>
```
o
```
Authorization: Bearer <EXTERNAL_API_KEY>
```

- La key es la env var **`EXTERNAL_API_KEY`** del servidor. Si no está configurada → toda la API responde `401`.
- Key ausente o incorrecta → `401 { "error": "...", "code": "UNAUTHORIZED" }`.
- La noticia se crea a nombre del usuario de sistema **`api`** (no hay sesión).

---

## 2. Quick start (lo más simple)

Una noticia con título + cuerpo Markdown, en una categoría que **ya exista**:

```bash
curl -X POST 'https://<host>/api/external/v1/news' \
  -H 'X-API-Key: <TU_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Mantenimiento programado",
    "body": "## Sábado 20/07\nCorte de 02:00 a 04:00 por obra de fibra.",
    "category": "Red"
  }'
```

---

## 3. Referencia de campos

El endpoint acepta **JSON** (`application/json`) o **multipart/form-data** (para subir archivos).
Los campos escalares son iguales en los dos modos.

| Campo            | Tipo    | Req. | Reglas |
|------------------|---------|------|--------|
| `title`          | string  | ✅   | 1..200 caracteres |
| `body`           | string  | ✅   | **Markdown**, 1..20000 caracteres |
| `category`       | string  | ✅   | **nombre** de una categoría existente (case-insensitive) |
| `pinned`         | boolean | —    | default `false`. Fija la noticia arriba. En multipart: `"true"`/`"false"` |
| `links`          | array   | —    | adjuntos de tipo link — `[{ "url": "https://…", "title"?: "..." }]`. En multipart: un **string JSON** del array |
| `files`          | binario | —    | **solo multipart** — campo repetido `files`. Ver reglas abajo |
| `sendToWhatsapp` | boolean | —    | default `false`. Si `true`, difunde al canal del NOC. En multipart: `"true"`/`"false"` |

### Reglas de adjuntos
- **Links** (`links`): `url` debe ser `http(s)`, ≤ 2048 chars; `title` ≤ 200 chars.
- **Archivos** (`files`, solo multipart): tipos `jpg`, `png`, `webp`, `gif`, `pdf`, `md`.
  **10 MB por archivo**, **máx 10 archivos**, **máx 40 MB en total** por request.
- **Cupo combinado**: `links` + `files` no puede superar **20 adjuntos** por noticia.

---

## 4. El campo `sendToWhatsapp` (difusión al NOC)

- `false` o ausente → solo se crea la noticia. `whatsapp: { "requested": false, "sent": false }`.
- `true` → además difunde la noticia al canal **noc lider** por WhatsApp (`📢 {título} + link`).

**Es best-effort**: si la difusión falla (WhatsApp/Evolution caído o sin configurar), **la noticia
igual se crea** (respuesta `201`) y el fallo se reporta en el campo `whatsapp`:

| Escenario | `whatsapp` |
|-----------|------------|
| no pedida | `{ "requested": false, "sent": false }` |
| difusión OK | `{ "requested": true, "sent": true, "link": "https://<host>/admin/news?post=..." }` |
| difusión falló | `{ "requested": true, "sent": false, "error": "<CODE>" }` |

Códigos posibles en `whatsapp.error`: `NOC_BROADCAST_NOT_CONFIGURED`, `EVOLUTION_API_ERROR`,
`NOC_BROADCAST_LINK_BASE_MISSING`. (Un `201` nunca se cae por un fallo de difusión.)

---

## 5. Ejemplos

### 5.1 JSON con links + difusión al NOC

```bash
curl -X POST 'https://<host>/api/external/v1/news' \
  -H 'X-API-Key: <TU_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Corte programado zona Centro",
    "body": "## Mantenimiento\nEl **sábado** de 02:00 a 04:00 habrá corte por obra de fibra.\n\n- Nodo: Radio Mercedes\n- Afecta: PtP Hípico",
    "category": "Red",
    "pinned": true,
    "links": [
      { "url": "https://status.tuempresa.com/incidents/42", "title": "Estado del incidente" }
    ],
    "sendToWhatsapp": true
  }'
```

### 5.2 Multipart con archivos (fotos / PDF / .md)

`Content-Type: multipart/form-data` lo pone `curl` solo con `-F`. Los escalares van como
form-fields, `links` como **string JSON**, y cada binario como `-F "files=@ruta"` (repetible):

```bash
curl -X POST 'https://<host>/api/external/v1/news' \
  -H 'X-API-Key: <TU_KEY>' \
  -F 'title=Informe de obra Nodo Mercedes' \
  -F 'body=## Obra completada\nSe reemplazó el PtP por ONU bridge. Ver adjuntos.' \
  -F 'category=Red' \
  -F 'sendToWhatsapp=true' \
  -F 'links=[{"url":"https://maps.example.com/x","title":"Ubicación"}]' \
  -F 'files=@./foto-antena.jpg' \
  -F 'files=@./informe.pdf'
```

### 5.3 Node / fetch (JSON)

```js
const res = await fetch('https://<host>/api/external/v1/news', {
  method: 'POST',
  headers: {
    'X-API-Key': process.env.PROMINENSE_API_KEY,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    title: 'Aviso de mantenimiento',
    body: '## Hoy 22:00\nReinicio de BNG Canepa (~5 min de corte).',
    category: 'Red',
    sendToWhatsapp: true,
  }),
});
const data = await res.json();
console.log(res.status, data.whatsapp); // 201 { requested: true, sent: true, link: ... }
```

---

## 6. Respuesta `201`

```json
{
  "id": "b1404aae-88b2-41b4-bc5c-...",
  "title": "Corte programado zona Centro",
  "category": "Red",
  "pinned": true,
  "publishedAt": "2026-07-19T12:00:00.000Z",
  "attachments": [
    { "id": "...", "kind": "link", "filename": "Estado del incidente",
      "mimeType": null, "sizeBytes": null,
      "url": "https://status.tuempresa.com/incidents/42", "fileUrl": null,
      "createdAt": "..." }
  ],
  "whatsapp": { "requested": true, "sent": true, "link": "https://<host>/admin/news?post=..." }
}
```

- `attachments`: primero los links, después los archivos. Los binarios traen `fileUrl` (ruta interna
  del panel) y `url: null`; los links al revés.
- **`fileUrl` es INTERNO**: sirve el archivo detrás de la sesión del panel (permiso `news:read`),
  **no** se puede descargar con la API key. Es para que lo vean los usuarios del panel. El sistema
  externo crea la noticia; el archivo lo consume el equipo internamente.

---

## 7. Códigos de error

| Status | code | Cuándo |
|--------|------|--------|
| 401 | `UNAUTHORIZED` | falta / mal la API key |
| 400 | `VALIDATION_ERROR` | falta `title`/`body`/`category`, largo excedido, `pinned`/`sendToWhatsapp` no-boolean, `links` mal formado, o `link.url`/`title` inválidos |
| 422 | `NEWS_CATEGORY_NOT_FOUND` | la `category` (nombre) no existe |
| 422 | `INVALID_LINK_ATTACHMENT` | un `url` no es `http(s)` |
| 422 | `TOO_MANY_NEWS_ATTACHMENTS` | `links` + `files` > 20 |
| 413 | `FILE_TOO_LARGE` | un archivo supera 10 MB |
| 413 | `BATCH_TOO_LARGE` | la suma de los `files` supera 40 MB |
| 415 | `UNSUPPORTED_NEWS_ATTACHMENT_TYPE` | tipo de archivo no permitido |
| 400 | `TOO_MANY_FILES` | más de 10 archivos |
| 503 | `REPORTER_UNAVAILABLE` | el usuario de sistema `api` no está aprovisionado |
| 429 | `RATE_LIMITED` | superó 30 req/min |

Envelope de error: `{ "error": "<mensaje>", "code": "<CODE>" }`.

---

## 8. Notas prácticas

- **La categoría tiene que existir** de antes (se referencia por nombre). Creá las categorías desde
  el panel; el endpoint no las crea al vuelo.
- **Los `4xx` son all-or-nothing**: si la validación falla, no se crea nada.
- **No es idempotente**: si te da `500` (fallo de infra), la noticia pudo haber quedado creada — verificá
  antes de reintentar para no duplicar.
- **`sendToWhatsapp: true`** solo difunde si la Difusión NOC está configurada en el panel (URL de
  Evolution + instancia + canal + key). Si no, la noticia se crea igual y `whatsapp.error =
  NOC_BROADCAST_NOT_CONFIGURED`.
- El Markdown del `body` se renderiza de forma segura en el panel (sin ejecutar HTML/scripts).

---

*Referencia completa de TODOS los endpoints externos (clientes, contratos, tickets, noticias):
`docs/EXTERNAL-API.md` en el repo del backend.*
