# Suricata — Acciones Autónomas del Bot (API externa)

Guía práctica para que un Claude/bot que atiende tickets de Suricata **opere el
ticket de punta a punta por API**: leer, responder al cliente, cambiar estado,
cerrar y dejar nota interna. **100% autónomo — no hay checkpoint humano.** El
bot decide y ejecuta; no hay `confirm` que re-confirmar en ningún endpoint.

Esta API es DISTINTA del flujo manual del panel (que sí exige "permiso ok"
humano antes de responder). Ese gate sigue intacto y no se toca — esta es una
vía nueva y adicional, pensada para uso autónomo.

- **Base URL**: `https://<host>/api/external/v1/suricata`
- **Estado en producción**: los 4 flags de escritura están **activos** desde
  2026-09-14 (rollout escalonado, verificado en vivo contra un ticket real).

---

## Autenticación

Misma convención que el resto de la API externa (`docs/EXTERNAL-API.md`):

```
X-API-Key: <SURICATA_EXTERNAL_API_KEY>
```
o
```
Authorization: Bearer <SURICATA_EXTERNAL_API_KEY>
```

- Key **dedicada** de esta superficie (`SURICATA_EXTERNAL_API_KEY`, distinta
  de `EXTERNAL_API_KEY`) — pedísela a Ronald, no vive en este archivo.
- Sin key o key incorrecta → `401 { "error": "...", "code": "UNAUTHORIZED" }`.
- No hay sesión de usuario. Toda escritura queda auditada a nombre del usuario
  de sistema del bot (ver "Auditoría" abajo) — **es el requisito no
  negociable**: cada escritura por este camino queda marcada como hecha por
  el bot, siempre.

---

## Lectura (sin flag, siempre disponible)

### `GET /tickets` — listar tickets (filtros + paginación)

Query opcionales: `status`, `priority`, `areaId`, `assigneeId`,
`botState` (`sin_analizar|resuelto_bot|requiere_humano|stale`), `page`, `limit` (máx 100).

### `GET /tickets/:externalId` — detalle completo de un ticket

Incluye `messages[]` (historial real de WhatsApp vía Botpress), `attachments[]`,
`verdicts[]`. Ejemplo real:

```json
{
  "id": "d1257003-...", "externalId": "18943", "subject": "Sin Servicio",
  "status": "Open", "priority": "Normal", "areaName": "Soporte",
  "customerName": "...", "customerPhone": "...",
  "messages": [{ "author": "Cliente", "authorKind": "customer", "body": "...", "sentAt": "..." }]
}
```

`404` si el `externalId` no existe en el espejo.

### `GET /kpis` — métricas agregadas

`{ "total": 45, "resueltoBotPct": 0, "requiereHumanoPct": 0, "sinVeredictoPct": 100, "staleCount": 0, "sincronizadosHoy": 15 }`

---

## Escritura — las 4 acciones autónomas

Cada una tiene su **propio flag independiente** (`suricata-bot-{note,status,close,reply}-enabled`).
Apagar uno NUNCA afecta a los otros tres. Si el flag está en `false`:
`403 { "error": "...", "code": "FEATURE_DISABLED" }`.

Todas devuelven, en éxito, `201` con esta forma común:

```json
{ "auditId": "<uuid>", "applied": true, "auditPersisted": true }
```

- `auditId`: fila en `SuricataBotActionAudit` — **siempre existe**, incluso si
  la acción falla (se audita el intento, no solo el éxito).
- `auditPersisted: false` (raro): la acción SÍ se ejecutó del lado de
  Suricata/WhatsApp, pero no se pudo grabar el registro. **Nunca reintentar
  en este caso** — reintentar duplicaría la acción real (doble mensaje, doble
  cierre). Es solo un problema de bookkeeping.

Un fallo real (Suricata no responde, selector roto, etc.) es `502`:
```json
{ "error": "<detalle>", "code": "SURICATA_UNAVAILABLE", "auditId": "<uuid>" }
```
El `auditId` de un 502 queda marcado `outcome: 'failed'` — sirve para
diagnóstico, no indica que algo se ejecutó.

### `POST /tickets/:externalId/notes` — nota interna

```json
{ "text": "Escalado a NOC por falla de fibra confirmada" }
```
Nunca la ve el cliente. Aparece en la pestaña "Notas" del ticket en Suricata.

### `POST /tickets/:externalId/status` — cambiar estado

```json
{ "status": "Progreso" }
```
`status` debe ser EXACTO uno de este catálogo (si no, `400 VALIDATION_ERROR`
antes de tocar Suricata):
`Open, Progreso, Esperando Respuesta, Nuevo, Llamada Programada, Oferta Rechazada, Oferta Aceptada, Firma Contrato, Ganado, Perdido`.

No hay un valor "Cerrado" en esta lista — cerrar es la acción de abajo, **no**
un cambio de estado.

### `POST /tickets/:externalId/close` — cerrar el ticket

```json
{ "reason": "Resuelto: se reinició el ONU y volvió la señal" }
```
Cierra en Suricata (queda "solo lectura" ahí). El `reason` es texto libre, va
a la descripción del cierre — no hay catálogo de motivos que elegir.

### `POST /tickets/:externalId/reply` — responder al cliente

```json
{ "body": "Hola! Ya revisamos tu conexión, ¿podés reiniciar el router y contarme si volvió?" }
```
Manda un WhatsApp REAL al cliente vía Botpress (no Playwright/DOM — por eso
funciona incluso con el ticket ya cerrado, son caminos independientes,
confirmado en producción). En éxito, además de lo común, puede traer:
```json
{ "...": "...", "whatsappId": "wamid.HBg..." }
```
`whatsappId` es la prueba real de despacho (viene de Botpress cuando la
etiquetó). Su ausencia no significa que no se envió, solo que no llegó ese tag.

Un ticket **sin conversación de Botpress vinculada** (nunca escribió por
WhatsApp) da `502 SURICATA_UNAVAILABLE` — no hay a quién mandarle el mensaje.

---

## Ejemplo end to end (curl)

```bash
API=https://<host>/api/external/v1/suricata
KEY=<SURICATA_EXTERNAL_API_KEY>

curl -s "$API/tickets/18943" -H "X-API-Key: $KEY"

curl -s -X POST "$API/tickets/18943/notes" -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"text":"Nota de prueba"}'

curl -s -X POST "$API/tickets/18943/reply" -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"body":"Hola, seguimos tu caso."}'
```

---

## Gotchas para el bot que consume esto

- **No hay "deshacer".** `close` y `reply` son irreversibles del lado real
  (WhatsApp entregado, ticket cerrado en Suricata). Pensar antes de llamar.
- **`status`/`close` pueden tardar unos segundos** (Suricata es Playwright del
  lado del servidor, no una API instantánea) — no asumir timeout corto.
- **Auditoría siempre existe**, incluso en fallo — si necesitás diagnosticar
  "¿esto se aplicó de verdad?", el `auditId` + `outcome` en
  `SuricataBotActionAudit` es la fuente de verdad, no el código HTTP solo.
- Esta API es independiente del flujo manual del panel (`suricata-reply-enabled`
  interno + permiso RBAC) — un flag no gatea al otro.
