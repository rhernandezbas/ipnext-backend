# Design: WhatsApp Template CTA Button

**What**: Design SDD `whatsapp-template-buttons` — botón Call-to-Action (URL) opcional en la creación de templates de WhatsApp. Cambio aditivo en 4 capas + fake in-memory + 2 rutas.

**Why**: Subir click-through de cobranza con un botón real en vez de URL pegada como texto crudo en el body.

**Where**: openspec/changes/whatsapp-template-buttons/design.md. Archivos: src/domain/ports/TemplateMessagingPort.ts, src/application/dto/messaging-templates.dto.ts, src/application/use-cases/messaging/CreateTemplate.ts, src/infrastructure/adapters/twilio/TwilioContentGateway.ts (~L194-210), src/infrastructure/http/routes/external-messaging.routes.ts (~L125 Zod), src/infrastructure/http/routes/templates.routes.ts (~L62 hand-map), src/infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway.ts (~L98).

**Decisiones**:
1. Shape SINGULAR `button?: { title: string; url: string }`, no `buttons[]`. Plural NO es gratis: `actions` de Twilio admite tipos mixtos (URL/PHONE_NUMBER) con tope de Meta ⇒ obligaría union discriminada, errores por índice, reglas de orden y cantidad, todo para capacidad fuera de scope. Widening a plural después es backward-compatible; narrowing no.
2. Validación en el USE CASE con helper puro module-private `assertValidButton()` en CreateTemplate.ts, tirando `InvalidTemplateInputError` (ya mapeado a 400). Rechazado value-object de dominio (no existe ese patrón en el repo — todas las reglas de CreateTemplate son inline) y rechazado Zod en la ruta (hay DOS superficies de creación, la externa con Zod y la interna hand-mapped; la regla aplicaría a una sola).
3. Reglas: title trim no vacío ≤25 chars; url parseable como absoluta con protocolo https:/http: (https preferido) ≤2000 chars. Los topes 25/2000 son ASUNCIÓN (límites publicados de Meta, no verificados offline); ser más estricto solo arriesga 400 falso — el rechazo autoritativo llega en /submit.
4. Payload Twilio: `types: input.button ? { 'twilio/call-to-action': { body, actions: [{ type: 'URL', title, url }] } } : { 'twilio/text': { body } }`.

**Learned**:
- GOTCHA CRÍTICO: validar la URL con `new URL(raw)` pero ENVIAR el string ORIGINAL. `new URL('https://x/{{1}}').href` percent-encodea las llaves (%7B%7B1%7D%7D) y rompería los placeholders de URL dinámica de Twilio. Nunca round-trippear la forma serializada.
- HALLAZGO NUEVO (no estaba en el proposal): hay DOS rutas de creación. `templates.routes.ts:62` mapea el body campo por campo a mano y `external-messaging.routes.ts:125` usa un Zod sin `.strict()` que STRIPEA claves desconocidas. Si solo se toca una, la otra pierde el botón en silencio — exactamente lo que el criterio de éxito prohíbe. Ambas deben tocarse.
- El fake `InMemoryTemplateMessagingGateway.createTemplate` (L98) registra un SUBCONJUNTO de campos en `createCalls`; hay que sumarle `button` o los tests de use case/ruta no pueden assertear el pass-through.
- GOTCHA de test: la respuesta 201 es IDÉNTICA con y sin botón — `toTemplateDto`/`TemplateDetailDto` solo exponen `body`. Assertear sobre `createCalls` del fake, jamás sobre la respuesta HTTP.
- CONFIRMADO el borde out-of-scope: `extractTemplateBody()` (TwilioContentGateway.ts:425-432) prioriza `twilio/text` y cae al PRIMER tipo con `body` string, así que `twilio/call-to-action` ya se lee. `/validate` y `/send` necesitan cero cambios de código. Gap aceptado: ni el preview ni `GET /templates/:sid` muestran el botón.
- Threat matrix N/A — sin routing/shell/subprocess/VCS; solo campos nuevos dentro de rutas autenticadas existentes.
