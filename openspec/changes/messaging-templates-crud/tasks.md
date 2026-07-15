# Change 3 (BE) — Templates WhatsApp CRUD (Twilio/Meta)

> EPIC Bulk v2 · PARALELO con C2 · mergea PRIMERO · BE-first (FE después) · TDD estricto (Jest + in-memory)

## Objetivo
Endpoints para VER / CREAR / SUBMIT-a-Meta / BORRAR templates de WhatsApp directo a Twilio Content API. Hoy es solo lectura (`GET /messaging/bulk/templates`). Decisión del usuario: **CRUD completo incluyendo BORRAR** (borrar toca Meta, irreversible).

## Endpoints Twilio (verificados en la doc, Basic Auth accountSid:authToken, host content.twilio.com, JSON)
- CREATE: `POST /v1/Content` — body `{friendly_name, language, variables:{"1":"..."}, types:{"twilio/text":{body}}}` → devuelve `sid` (HX…)
- GET one: `GET /v1/Content/{sid}`
- DELETE: `DELETE /v1/Content/{sid}?deleteInWaba=true` (borra TAMBIÉN de Meta/WABA)
- SUBMIT: `POST /v1/Content/{sid}/ApprovalRequests/whatsapp` — body `{name (lowercase_+alfanum), category: UTILITY|MARKETING|AUTHENTICATION}`
- APPROVAL STATUS: `GET /v1/Content/{sid}/ApprovalRequests` (ya se lee vía ContentAndApprovals en el list existente)
- **Meta NO deja editar submitted/aprobado** → "editar aprobado" = CLONAR (nuevo POST) + re-submit. NO exponer PUT en v1.

## Diseño BE (hexagonal — el port aísla de Twilio)

### Port `src/domain/ports/TemplateMessagingPort.ts` (extender, +4 métodos)
- `createTemplate(input: CreateTemplateInput): Promise<TemplateDto>`
- `getTemplate(contentSid: string): Promise<TemplateDto>`
- `deleteTemplate(contentSid: string, deleteInWaba?: boolean): Promise<void>`
- `submitForApproval(contentSid: string, name: string, category: string): Promise<void>`

### Adapter `src/infrastructure/adapters/twilio/TwilioContentGateway.ts` (implementar los 4)
- `createTemplate`: `POST ${contentBaseUrl}/v1/Content` con `auth()`, **JSON** (OJO: distinto del `sendTemplate` que es form-urlencoded contra api.twilio.com). Mapear respuesta cruda → `TemplateDto` (reusar `extractTemplateBody`).
- `deleteTemplate`: `DELETE .../v1/Content/${sid}?deleteInWaba=${bool}`.
- `submitForApproval`: `POST .../v1/Content/${sid}/ApprovalRequests/whatsapp` con `{name, category}`.
- `getTemplate`: `GET .../v1/Content/${sid}`.
- SIN env nuevas (mismas accountSid/authToken del ctor). Reusar el mapeo de error existente (`mapSendError`, `RETRYABLE_STATUS`, `CONFIG_STATUS`) y los errores de `@domain/errors/messaging-bulk` (`TemplateProviderUnavailableError`/`TemplateSendRejectedError`/`TemplateProviderConfigError`).

### Fake `src/infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway.ts` (los 4 métodos, para TDD)

### Use cases nuevos `src/application/use-cases/messaging/` (verbo+sustantivo, 1 por archivo)
- `CreateTemplate.ts` — valida body/variables/category, mapea a DTO curado.
- `SubmitTemplateForApproval.ts` — valida `category` ∈ enum, normaliza `name` (lowercase_).
- `DeleteTemplate.ts` — **antes de borrar, consultar `CampaignRepository` si hay campaña `pending`/`running` con ese `contentSid`** → si la hay, devolver un error tipado/aviso (no borrar a ciegas). Como mínimo exponer el dato.
- `GetTemplate.ts` (para "ver ficha").

### Rutas — NUEVO `src/infrastructure/http/routes/templates.routes.ts` (NO ampliar messagingBulk.routes)
- `POST   /api/messaging/templates`            → CreateTemplate (RBAC `messaging.bulk`)
- `GET    /api/messaging/templates`            → ListTemplates (reusar existente; RBAC `messaging.templates`)
- `GET    /api/messaging/templates/:sid`       → GetTemplate (`messaging.templates`)
- `POST   /api/messaging/templates/:sid/submit`→ SubmitTemplateForApproval (`messaging.bulk`)
- `DELETE /api/messaging/templates/:sid`       → DeleteTemplate (`messaging.bulk`)
- Molde try/catch→`next(err)` de messagingBulk.routes (el errorHandler global mapea DomainError). Montar en `app.ts` (bloque messaging — OJO colisión con C2, mantener el diff acotado).

### RBAC: read=`messaging.templates` (ya existe), write (create/submit/delete)=`messaging.bulk` (ya existe). SIN acción nueva → no toca rbac.ts ni su test de conteo.

### DTOs: `src/application/dto/messaging-templates.dto.ts` NUEVO (no pisar messaging-bulk.dto.ts, evita merge con C2). `CreateTemplateInput` (friendlyName, language, category, body, variables[]). Nunca devolver el JSON crudo de Twilio.

## Scenarios (TDD — test primero)
- createTemplate: input válido → llama al gateway con el shape correcto → DTO curado (sin leak). Input inválido (body vacío, category fuera de enum) → 400/422.
- submitForApproval: category válida + name normalizado → gateway; category inválida → 400.
- deleteTemplate: sin campañas activas → borra; **con campaña pending/running usando ese contentSid → NO borra, error tipado**.
- getTemplate: sid existe → DTO; no existe (404 Twilio) → error tipado → 404.
- rutas: 401 sin auth; RBAC (read vs write); DTO curado; errores mapeados (503 provider unavailable, 400 rejected).
- gateway (con http mockeado): create=POST /v1/Content JSON; delete=DELETE ?deleteInWaba; submit=POST .../ApprovalRequests/whatsapp; auth Basic.

## Tasks
- [ ] T1 tests + extender port + fake in-memory (4 métodos). RED→GREEN.
- [ ] T2 tests + TwilioContentGateway (4 métodos, http mockeado). RED→GREEN.
- [ ] T3 tests + use cases (Create/Submit/Delete[guard campañas]/Get). RED→GREEN.
- [ ] T4 tests + templates.routes.ts + wiring app.ts + RBAC. RED→GREEN (seam completo: ruta REAL + use case REAL + fake gateway).
- [ ] T5 composition-root pin (app.ts wirea el router de templates).
- [ ] T6 gate: `npm test` (jest) archivos del change + `tsc --noEmit`. NO commitear.
```