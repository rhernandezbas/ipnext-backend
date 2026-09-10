# Exploration: WhatsApp invoice-detail quick-reply button

## Contexto

Feature mostrada por el dueño: al tocar un botón tipo "Ver mis facturas" en WhatsApp (ejemplo de otro proveedor, "USS"), llega un mensaje NUEVO en el mismo hilo con el detalle real de las facturas pendientes del cliente (número, vencimiento, saldo, links de "ver"/"pagar ahora"/"pagar luego del vencimiento" por factura). No es un botón de URL (como el que ya shippeamos en `whatsapp-template-buttons`) — es un mecanismo que dispara una respuesta automática dinámica.

## Estado actual (evidencia, no supuestos)

1. **Mecanismos de botón hoy**: `TwilioContentGateway.createTemplate()` (`src/infrastructure/adapters/twilio/TwilioContentGateway.ts:194-217`) solo crea `twilio/text` y `twilio/call-to-action` (botón URL, hardcodeado `type:'URL'`). No existe rama de creación para `twilio/quick-reply`. `TemplateButton`/`CreateTemplateInput.button` (`TemplateMessagingPort.ts:77-100`) es un shape único no discriminado `{title, url}` — solo sirve para CTA-URL, habría que ampliarlo a una unión discriminada. `extractTemplateBody()` (`TwilioContentGateway.ts:432-439`) SÍ tolera bodies de `twilio/quick-reply` — confirmado real (no es un supuesto de una exploración previa) — pero es un fallback genérico de lectura ("el primer type con body"), no scaffolding a propósito. El lado de CREACIÓN no tiene nada para quick-reply.

2. **Ya existe precedente de respuesta automática determinística**: `ReceiveChatwootWebhook.ts` tiene `maybeRegisterOptOut` (`src/application/use-cases/messaging/ReceiveChatwootWebhook.ts:537-573`) — un handler determinístico, sin IA, que matchea el `content` entrante contra keywords exactas (BAJA/STOP) y dispara una acción, fail-open, dependencia opcional del constructor. Es la plantilla lista para un nuevo handler "se tocó el botón". El hook del asistente de IA (`maybeReplyWithAssistant`, líneas 456-490) es un mecanismo estructuralmente separado.

3. **El asistente parkeado es genuinamente separable (el hallazgo central)**: `ai-assistant-cobranzas` se construyó, se shippeó, y el dueño lo parkeó (2026-09-06; el commit `e36b45b7` de hoy confirma "flag OFF... ESTACIONADO"). El kill-switch `ASSISTANT_ENABLED_FLAG='ai-assistant-enabled'` se lee SOLO adentro de `ReplyWithAssistant.execute()` (`ReplyWithAssistant.ts:43,184`). Pero la lógica de búsqueda en GR + render que esta feature necesita ya existe como primitivas puras, libres de IA y ajenas al flag: `renderInvoiceBlock()` (función pura, `renderInvoiceBlock.ts:43-61`), `ClienteFacturasResolver.resolve()` (`ClienteFacturasResolver.ts:51-88`, usa `RefreshClientBalanceIfStale` + `AssistantInvoicesReader`), y el puerto/adapters de `AssistantInvoicesReader`. Ninguno referencia el flag. **Conclusión: esta feature NO necesita tocar `ai-assistant-enabled` ni `ReplyWithAssistant` para nada** — puede reusar (importar o duplicar) estas primitivas ya testeadas y determinísticas en un módulo nuevo y aislado.

4. **La integración con Gestión Real es un adapter de backend real**, no scripts ad-hoc: `GestionRealClient.ts` ya parsea `GrInvoice[]` (tipo, numero, fechaVto, saldo, urlPdf, paymentUrl) alimentando el mismo espejo que usa el asistente parkeado.

5. `whatsapp-template-buttons` está terminado pero sin pushear en su propio worktree/branch al momento de esta exploración — correctamente tratado como no relacionado a este cambio nuevo.

## Enfoques posibles

1. **Importar las primitivas puras del asistente directamente** (nueva rama determinística en el webhook, sin pasar por `ReplyWithAssistant`). Esfuerzo bajo-medio; olor de acoplamiento chico (import de solo-lectura desde archivos de la feature parkeada).
2. **Extraer un núcleo compartido** usado por ambos (asistente + esta feature). Esfuerzo medio; requiere tocar archivos de la feature parkeada — NO recomendado dado que el dueño decidió explícitamente "dejarlo en paz".
3. **Aislamiento total — duplicar las ~100 líneas** de resolver/render en un módulo nuevo sin ningún import de `assistant/*`. Esfuerzo bajo-medio; más seguro para no desestabilizar la feature parkeada.

## Recomendación

Enfoque 1 o 3 (decisión del dueño en `sdd-propose`); se descarta el Enfoque 2. Default al Enfoque 3 salvo que el dueño esté cómodo con el import de solo lectura.

## Riesgos

- El mecanismo quick-reply → respuesta automática de Twilio no está verificado en vivo desde esta sola exploración de código.
- Matchear por el TÍTULO del botón es frágil si el título se edita después (misma clase de falla que "feature sin perilla inerte" — verificar y usar un id/payload estable, pendiente de verificación en vivo).
- `TemplateButton` necesita una unión discriminada sin romper el shape CTA-only ya construido (sin pushear todavía).
- Tentación de scope-creep: prender de nuevo `ai-assistant-enabled` en vez de construir el camino angosto — hay que descartarlo explícitamente con el dueño.

## Listo para propuesta

Sí — el alcance está acotado y respaldado por evidencia; el punto 3 queda respondido de forma concluyente como separable.
