# Proposal — bulk-csv-recipients (EPIC Mensajería WhatsApp · Change D)

## 1. Why / Intent

El Bulk WhatsApp hoy targetea por 3 dominios: **segmento** (`{statuses[], balanceMin?, balanceMax?}`),
**lista manual de clientes** (`manualClientIds`, picker del composer) — y nada más. Todo destinatario
DEBE ser un `Client` existente: `CampaignRecipient.clientId` es NOT NULL con
`@@unique([campaignId, clientId])` (`prisma/schema.prisma:3004,3024`).

**Falta el 4to dominio: CSV.** El operador tiene listas externas (prospectos, avisos de obra,
contactos que NO son clientes todavía) con `nombre, número` y hoy no puede subirlas. Decisiones de
producto YA tomadas (2026-07-16, NO re-abrir):

- **(a) Validador estricto de 2 columnas** (nombre, número): un archivo con OTRA estructura se
  RECHAZA entero; de un archivo estructuralmente válido entran SOLO las filas válidas.
- **(b) Números crudos admitidos** (gente que puede NO ser cliente). Si el teléfono matchea un
  cliente existente → se VINCULA (cliente activo = camino normal; **cliente `baja` = se ADMITE pero
  SEÑALADO visualmente**); opt-out respetado en los vinculados.
- **(c) Los INVÁLIDOS/EXCLUIDOS tienen que ser VISIBLES en el preview** (por persona, con motivo)
  para poder corregirlos. Hoy el `PreviewModal` solo muestra contadores agregados
  `skipped {optedOut, duplicatePhone, invalidPhone}` (`PreviewModal.tsx:290-296`) — sin detalle.

Este change cierra además la **deuda del F4** documentada en el propio FE: "el BE aún NO extendió
`/segment/recipients` con `manualClientIds`" (`PreviewModal.tsx:20-29` + el hack `manualNote`
en `:226-237`).

## 2. Scope IN

### BE (primero)

1. **`manualContacts?: Array<{name, phone}>`** — nuevo input top-level en
   `CreateCampaignInput`/`PreviewSegmentInput`/`ListSegmentRecipientsInput`, PARALELO a `segment` y
   `manualClientIds` (mismo patrón). Una campaña es válida con segmento O manuales O contactos CSV
   (cualquier combinación no vacía).
2. **Vinculación por teléfono** — cada contacto válido se matchea contra la base de `Client` por
   clave `normalizePhone`; si matchea → el recipient se crea VINCULADO (`clientId` seteado, hereda
   opt-out/status/balance del Client). Cliente `baja` = admitido, señalado (no-excluyente).
3. **Contactos crudos persistibles** — migración ADITIVA: `CampaignRecipient.clientId` pasa a
   nullable + nueva columna `contactName`. El pipeline de envío/proyección soporta recipients sin
   `clientId`.
4. **Preview con detalle por persona** — `POST/GET /segment/recipients` extendido con
   `manualClientIds` (cierra deuda F4) + `manualContacts` + `view: 'recipients' | 'excluded'`:
   la vista `excluded` devuelve PAGINADO el detalle nombre + teléfono + motivo
   (`sin_nombre | sin_telefono | telefono_invalido | opt_out | duplicado`) de cada excluido;
   la vista `recipients` suma por-item `clientId | null`, `source` y el `status` (`'baja'` = flag
   visual; `'no_cliente'` = contacto no vinculado).
5. **Caps y errores tipados** — `manualContacts` capado en 5000 (mismo criterio FIX-3,
   `resolveCombinedRecipients.ts:21`); payload malformado → 400; exceso → 422.

### FE (después, sobre el BE ya verde)

6. **Parser CSV propio** (sin dependencia nueva) con matriz de tests: BOM, CRLF/CR/LF, separador
   `;`/`,`/tab autodetectado, comillas con `""` escapado, header opcional detectado. Estructura
   inválida → rechazo TOTAL del archivo con línea y motivo.
7. **`CsvRecipientsUploader`** en el composer: carga, resumen (N válidas / M inválidas con
   detalle por línea), quitar archivo. Estado en `CampaignComposer`, payload `manualContacts`.
8. **PreviewModal extendido**: consulta la UNIÓN completa (segmento + manuales + CSV — borra el
   hack `manualNote`), sección/tab "Excluidos" con la tabla paginada de motivos, señalado de
   `baja` (badge + texto, nunca solo color) y de `no_cliente`.

## 3. Scope OUT

- Opt-out para números NO vinculados a un Client (el registro de opt-out vive en
  `Client.whatsappOptOutAt` — un contacto crudo no tiene dónde registrarlo; si después se hace
  cliente, el vínculo por teléfono lo cubre en la próxima campaña).
- Persistir/reusar "listas de contactos" como entidad propia (el CSV es input efímero del create).
- Import de clientes desde CSV (esto NO da de alta ningún `Client`).
- Delivery callbacks (F3) / cambios al send-path de Twilio más allá del branch sin-clientId.
- Rediseño visual del composer (Change C — corre DESPUÉS y se hace SOBRE esto).

## 4. Approach (resumen — detalle en design.md)

- **Datos**: `clientId String?` + `contactName String?` en `CampaignRecipient`; se CONSERVA
  `@@unique([campaignId, clientId])`; idempotencia de filas sin clientId la garantiza el adapter
  (pre-filtro por `phoneNormalized`). Migración aditiva vía `npm run prisma:migrate`.
- **Vínculo por teléfono**: `CampaignSegmentSource.listSegmentRecipients({statuses: []})` — el
  escape hatch OPT-2 ya documentado (`PrismaCustomerRepository.ts:224-227`) devuelve el universo
  completo de `Client` con status; match en memoria por `normalizePhone` (precedente
  `GetClientContextByPhone`/`matchActiveClient`). Cero port nuevo.
- **Resolución**: `resolveCombinedRecipients` se extiende a 3 fuentes con RETENCIÓN DE DETALLE de
  exclusiones (hoy solo cuenta); los contadores agregados existentes se derivan del detalle
  (backcompat total del wire actual).
- **Send**: `SendCampaign` branch por `recipient.clientId === null` (sin re-check SEND-5 — no hay
  Client; variables desde `contactName` y balance vacío, precedente FIX-18);
  `ProjectSentMessageInput.candidate` → `contactName` (el projector solo usa `candidate.name`,
  `PrismaCampaignInboxProjector.ts:35`). La proyección al inbox ya es phone-keyed
  (`Conversation` NO tiene clientId, `schema.prisma:2807-2823`) — funciona sin cambios de schema.
- **FE**: parser propio ~150 líneas + tests (papaparse rechazado — ver design D8), componente
  uploader, PreviewModal con `view=excluded`.

## 5. Riesgos

| Riesgo | Mitigación |
|---|---|
| Migración sobre tabla con datos prod (`clientId` NOT NULL → nullable) | ALTER aditivo (DROP NOT NULL + ADD COLUMN) — sin rewrite de tabla en PG, sin backfill |
| `bulkCreateRecipients` re-fetchea por `clientId IN (...)` (`PrismaCampaignRepository.ts:153-156`) — con NULL se rompe | Cambiar re-fetch a `phoneNormalized IN (...)` (NOT NULL siempre) — mismo contrato |
| Parser CSV propio con bug de quoting | Matriz de tests dedicada (spec FE) + rechazo total ante ambigüedad (estricto juega a favor) |
| Doble envío a un número que está en CSV y en el segmento | Dedup por `phoneNormalized` cross-source con precedencia segmento > manual > CSV (extiende FIX-1) |
| FE colisiona con el REDISEÑO (Change C) | C corre después y se hace SOBRE esto; componentes nuevos aislados (uploader, tab excluidos) |

## 6. Success criteria

- Campaña solo-CSV, CSV+segmento y CSV+manual crean y ENVÍAN end-to-end (tests de use case +
  seam supertest verdes).
- Un teléfono de CSV que es cliente activo queda vinculado; uno de cliente `baja` entra flaggeado;
  uno con opt-out queda excluido y VISIBLE con motivo.
- El preview muestra POR PERSONA los excluidos con motivo, paginado (sin fetch-all en el wire).
- Cero regresión: campañas por segmento/manual se comportan EXACTO igual (suites existentes verdes
  sin modificar aserciones de comportamiento).
