# Proposal — messaging-campaign-manual-recipients (EPIC Mensajería WhatsApp, F2 · extensión)

## 1. Why / Intent

`messaging-bulk` (F2) ya está en prod: una campaña de WhatsApp se arma resolviendo un **segmento**
(`{ statuses[], balanceMin?, balanceMax? }`) contra la base de `Client`, con opt-out/dedup/teléfono
inválido enforced por `resolveRecipients`. Pero HOY una campaña SOLO puede targetear por segmento.

**Falta**: poder armar una campaña con una **lista MANUAL de clientes** elegidos a mano (el operador
selecciona clientes puntuales en el composer), además del —o en vez del— segmento. Casos reales:
"mandale este aviso a estos 12 clientes que llamaron", "recordatorio al segmento `late` PERO sumá
también estos 3 que sé que deben aunque el sync no los marcó".

## 2. Scope IN (v1 · BE-only este change)

1. **Lista manual combinable** — el input de crear campaña acepta `manualClientIds?: string[]`, un
   input PARALELO al `segment` (NO dentro de él). Una campaña es válida si tiene:
   - solo segmento (comportamiento actual, INTACTO), o
   - solo lista manual, o
   - ambos (unión deduplicada por `clientId`).
2. **Dedup por `clientId`** — la unión de (destinatarios del segmento) ∪ (clientes de la lista manual)
   se deduplica en memoria por `clientId` ANTES del insert. El `@@unique([campaignId, clientId])` de DB
   es la segunda red; no dependemos de que el insert falle.
3. **Fail-loud en id inexistente** — si algún `manualClientId` no resuelve a un `Client`, la request se
   RECHAZA con un error de dominio tipado (`ManualRecipientsNotFoundError` → 422) que expone CUÁLES ids
   faltan. Nunca se dropea en silencio.
4. **Compliance preservada** — los clientes de la lista manual pasan por el MISMO `resolveRecipients`
   que el segmento: opt-out excluido SIEMPRE (no negociable), teléfono inválido descartado, dedup por
   `normalizePhone`. Existencia = fail-loud; compliance = exclusión silenciosa (igual que el segmento).
5. **Búsqueda por teléfono** — `buildClientListWhere` (search de `ListClients`) suma `phone` al OR
   (hoy solo matchea `name`/`email`/`login`), para que el composer pueda encontrar por fragmento de
   teléfono al armar la lista manual.
6. **Preview de la unión** — `PreviewCampaignSegment` puede contar la unión (segmento ∪ manuales) sin
   doble-contar los manuales que ya caen en el segmento.

## 3. Scope OUT

- FE (composer con selector de clientes + búsqueda) → cambio COORDINADO aparte.
- Cambios de schema (`CampaignRecipient` ya tiene `@@unique([campaignId, clientId])` — no hace falta
  migración).
- Nuevos permisos RBAC (reusa `messaging.bulk`).

## 4. Approach / Arquitectura (hexagonal)

- **DTO**: `CreateCampaignInput` suma `manualClientIds?: string[]`. `PreviewSegmentInput` idem
  (opcional). Es un input paralelo, NO parte de `CampaignSegment`.
- **Port nuevo narrow (ISP)**: `ManualRecipientSource.findRecipientCandidatesByIds(clientIds)` en
  `domain/ports/CustomerRepository.ts`, mismo criterio de segregación que `CampaignSegmentSource`/
  `CampaignRecipientLookup`/`OptOutRegistry` (ya separados ahí). Devuelve SOLO los ids que existen
  (subset); el caller detecta faltantes por set-diff → fail-loud. `PrismaCustomerRepository` lo
  implementa (misma instancia `customerAdapter` en el wiring).
- **Helper de resolución compartido**: `resolveCombinedRecipients` orquesta (resolver segmento si tiene
  criterio) + (resolver+validar manuales) + unión dedup por `clientId`. Lo usan `CreateCampaign` y
  `PreviewCampaignSegment` (DRY).
- **Guard nuevo**: `assertHasRecipients(segment, manualClientIds)` — válido si segmento filtrado O lista
  manual no vacía. `assertSegmentIsFiltered` queda INTACTO para `ListSegmentRecipients` (que NO recibe
  lista manual).
- **Error tipado**: `ManualRecipientsNotFoundError` (`MANUAL_RECIPIENTS_NOT_FOUND` → 422), expone
  `missingClientIds` al wire vía `domainErrorToCode` + `errorHandler`.

Dependencias hacia adentro respetadas: los use cases dependen de PORTS (`ManualRecipientSource`), nunca
de Prisma. DTO curado (nunca entidad Prisma cruda).

## 5. Riesgos

- Colisión de teléfono ENTRE un cliente manual y uno del segmento (distinto `clientId`, mismo phone):
  el dedup de la unión es por `clientId` (no por phone), así que ambos entran. Es intencional — la lista
  manual es una inclusión EXPLÍCITA. `resolveRecipients` dedup por phone DENTRO de cada set; el cross-set
  no se colapsa. Documentado en `design.md §Decisión-dedup`.

## Artefactos

- `openspec/changes/messaging-campaign-manual-recipients/{proposal,design,tasks}.md`
- `openspec/changes/messaging-campaign-manual-recipients/specs/messaging-bulk/spec.md` (delta)
