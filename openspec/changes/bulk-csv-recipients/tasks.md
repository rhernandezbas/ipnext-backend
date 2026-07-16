# Tasks — bulk-csv-recipients

**Change**: bulk-csv-recipients · **Phase**: tasks · **Projects**: ipnext-backend (batches B*) →
ipnext-frontend (batches F*)
**TDD**: test que falla PRIMERO, después el mínimo código, después refactor. Correr SOLO los
archivos de test afectados durante el loop (el gate completo lo corre el orquestador).

**ORDEN**: BE completo primero (B1→B5), FE después (F1→F4) — el FE consume el contrato nuevo.

**COORDINACIÓN**: el REDISEÑO del composer (Change C) corre DESPUÉS de este change y se hace SOBRE
él. Los batches F* deben dejar componentes AISLADOS (uploader, tab excluidos) para minimizar la
superficie de colisión. Si C arranca antes de que F* termine: F* tiene prioridad de merge, C rebasea.

---

## Batch B1 — Dominio/aplicación: normalización, guard, cap, errores (CSV-1, CSV-5)

- [x] **B1.1 — DTO `manualContacts`**
  - `CreateCampaignInput` / `PreviewSegmentInput` / `ListSegmentRecipientsInput` +
    `manualContacts?: Array<{name: string, phone: string}>` (`messaging-bulk.dto.ts`).
- [x] **B1.2 — `normalizeManualContacts`** (molde `normalizeManualClientIds`,
  `resolveCombinedRecipients.ts:160-172`)
  - Test: trim de name/phone; descarta items con AMBOS vacíos; preserva orden.
- [x] **B1.3 — errores tipados + statusMap**
  - `InvalidManualContactsError` (400) + `TooManyManualContactsError` (422) en
    `domain/errors/messaging-bulk.ts` + `statusMap`/`domainErrorToCode`.
  - Test: cap `MAX_MANUAL_CONTACTS = 5000` chequeado ANTES de tocar la fuente (molde FIX-3,
    `resolveCombinedRecipients.ts:83-85`).
- [x] **B1.4 — `assertHasRecipients` con 3er componente** (CSV-1)
  - Test: `{statuses:[]}` + sin manuales + `manualContacts` no vacío → NO lanza; todo vacío →
    `UnfilteredSegmentError` (no-regresión).

## Batch B2 — Resolución: detalle de exclusiones + vínculo por teléfono (D3, D7; CSV-2/4/6)

- [x] **B2.1 — `resolveRecipients` con detalle** (ADITIVO)
  - Test: devuelve `excluded: [{candidate, reason}]` con `sin_telefono` vs `telefono_invalido`
    diferenciados; contadores existentes DERIVADOS (`excludedNoPhone = sin_telefono +
    telefono_invalido`) — aserciones actuales de `resolveRecipients.test.ts` intactas.
- [x] **B2.2 — match de contactos por teléfono**
  - Helper que arma `Map<normalizePhone(client.phone), candidate>` desde
    `segmentSource.listSegmentRecipients({statuses: []})` (escape hatch OPT-2,
    `PrismaCustomerRepository.ts:224-227`) y resuelve cada contacto:
    vinculado (candidate del Client) / crudo (`clientId: null`, status `no_cliente`).
  - Tests: match exacto (NO suffix); ambigüedad activo>baja, desempate clientId menor; opt-out del
    vinculado → excluido `opt_out`; baja → INCLUIDO con `status:'baja'`.
- [x] **B2.3 — `resolveCombinedRecipients` a 3 fuentes**
  - Tests: precedencia segmento > manual > CSV por `phoneNormalized`; duplicado interno del CSV
    (primera aparición gana); contacto que vincula a un clientId ya presente → `duplicado`;
    `excludedDetail` plano con `source`; `resolved` items con `clientId|null` + `source` +
    `contactName`. Universo solo se consulta si `manualContacts` no vacío (no toca la fuente en
    flujos actuales — no-regresión de queries).
- [x] **B2.4 — `PreviewCampaignSegment` con contactos** (CSV-6)
  - Tests: `count` unión 3 fuentes; `skipped` reconcilia (buckets del wire actuales);
    `statusCounts.no_cliente`; invariante `count + Σskipped = considerados`; sample con
    `clientId: null` para crudos.

## Batch B3 — Persistencia: migración + repos (PER-1/2/3)

- [x] **B3.1 — migración Prisma** (PER-1)
  - `clientId String?` + relación opcional + `contactName String?`; `@@unique([campaignId,
    clientId])` se CONSERVA. `npm run prisma:migrate` (nombre sugerido:
    `campaign_recipient_contact_rows`). PROHIBIDO editar el SQL a mano.
  - Smoke: `messaging-bulk-inbox-migration.test.ts` como molde si aplica.
- [x] **B3.2 — entity + DTO nullable** (PER-3)
  - `CampaignRecipient.clientId: string | null` + `contactName: string | null`
    (`campaign.ts:71-96`), `CampaignRecipientDto` idem, `toCampaignRecipientDto` mapea.
- [x] **B3.3 — `bulkCreateRecipients` filas contact** (PER-2)
  - `CampaignRecipientCreateRow.clientId: string | null` + `contactName?`.
  - `InMemoryCampaignRepository`: test PRIMERO — idempotencia de fila NULL por `phoneNormalized`;
    mezcla vinculadas+crudas.
  - `PrismaCampaignRepository`: pre-filtro `findMany({where:{campaignId},
    select:{phoneNormalized}})` + re-fetch por `phoneNormalized IN` (HOY rompe con null:
    `PrismaCampaignRepository.ts:153-156`); `contactName` en el `createMany`.
- [x] **B3.4 — `CreateCampaign` materializa contactos** (CSV-1/2/3)
  - Tests: solo-CSV crea con `clientId:null`+`contactName`; CSV vinculado crea con `clientId`;
    mixta 3 fuentes; no-regresión solo-segmento/solo-manual (aserciones existentes intactas).

## Batch B4 — Envío + proyección (CSV-3, PRJ-1)

- [x] **B4.1 — `SendCampaign` branch `clientId === null`**
  - Tests (molde `SendCampaign.test.ts`): crudo → NO llama `findRecipientCandidate`, variables
    `{name: contactName, balanceDue: ''}`, queda `sent`; vinculado → re-check SEND-5 intacto
    (opt-out post-create → `opted_out`).
- [x] **B4.2 — `ProjectSentMessageInput.candidate` → `contactName`** (PRJ-1)
  - Refactor port + `PrismaCampaignInboxProjector` (usa solo `.name` hoy,
    `PrismaCampaignInboxProjector.ts:35`) + fakes.
  - Tests (`SendCampaign.projection.test.ts` / `CampaignInboxProjector.test.ts`): crudo proyecta
    Conversation con `contactName` del CSV + ChatMessage bulk + `conversationId` seteado;
    vinculado proyecta con el nombre del candidate fresco (no-regresión).

## Batch B5 — Listado con detalle + rutas + wiring (DET-1/2/3)

- [x] **B5.1 — `ListSegmentRecipients` extendido**
  - Constructor + 2do arg `manualRecipientSource` (opcional, molde `PreviewCampaignSegment.ts:22-27`);
    input con `manualClientIds`/`manualContacts`/`view`; guard → `assertHasRecipients`.
  - Tests: solo-manual 200 (fin deuda F4); unión mixta con `source`; `view:'excluded'` paginado
    (30 items, page 2/limit 20 → 10); no-regresión shape segment-only.
- [x] **B5.2 — rutas** (`messagingBulk.routes.ts`)
  - `toManualContacts(raw)` fail-loud (molde `toManualClientIds`, `:67-78`); POST
    `/segment/preview`, `/segment/recipients`, `/campaigns` parsean `manualContacts`; `view` en
    `/segment/recipients` (POST y GET); GET NO acepta `manualContacts` (DET-3).
  - Tests seam (supertest, repos in-memory): 400 malformado; 422 cap; create solo-CSV 201;
    excluded view 200.
- [x] **B5.3 — wiring `app.ts`**
  - `ListSegmentRecipients` recibe `customerAdapter` como manual source. Verificar aridad de los
    demás use cases sin cambios.
- [x] **B5.4 — gate BE completo**
  - Suite entera verde. Chequear que `GetCampaign`/`RecipientsTable` DTO con `clientId:null` no
    rompe serialización.

---

## Batch F1 — FE: parser CSV (CSV-FE-1/2/3)

- [ ] **F1.1 — `parseRecipientsCsv.ts`** en
  `src/pages/whatsapp/BulkMessagingPage/components/composer/`
  - Tests PRIMERO (matriz del spec): BOM; CRLF/CR/LF; separador `;`/`,`/TAB autodetectado fuera de
    comillas (empate `;`>`,`>TAB); comillas con `""`; comilla sin cerrar → rechazo con línea;
    ≠2 columnas → rechazo total con línea; header por heurística (col 2 sin dígitos); vacío/solo
    header → rechazo; filas `sin_nombre`/`sin_telefono` con línea; 5000 filas/1MB.

## Batch F2 — FE: uploader + composer (CSV-FE-4/5)

- [ ] **F2.1 — `CsvRecipientsUploader`** (presentacional + parse)
  - Tests: carga válida muestra resumen + inválidas expandibles; rechazo total con `role=alert` y
    línea; "Quitar archivo"; reemplazo de archivo.
- [ ] **F2.2 — `CampaignComposer` wiring**
  - Estado `csvContacts` + fingerprint para el debounce (NO `join` de 5000 en deps —
    `CampaignComposer.tsx:96-109`); `manualContacts` en payloads de preview/create OMITIDO si
    vacío (molde `:85-88, 161-163`); gate `hasRecipients` con 3er componente
    (`segmentCriteria.ts:37-39`); reset post-create.
  - Types/api: `manualContacts` en `PreviewSegmentInput`/`CreateCampaignInput`/
    `SegmentRecipientsQuery` (`types/messagingBulk.ts`, `messagingBulk.api.ts:48-73`).

## Batch F3 — FE: preview de la unión + excluidos + señalado (CSV-FE-6/7/8/9)

- [ ] **F3.1 — `PreviewModal` unión completa**
  - Query con input completo; `enabled` = hay destinatarios (borra gate segment-only
    `PreviewModal.tsx:93-104` y `manualCount`/`manualNote` `:20-29, 226-237`); keys de fila
    `clientId ?? phoneE164` (`:33-34, 187`); estado `no_cliente` con fallback de texto.
- [ ] **F3.2 — tab/sección "Excluidos (N)"**
  - Query `view:'excluded'` paginada propia (solo al activar la vista); labels es-AR por reason;
    columna fuente; estado vacío.
- [ ] **F3.3 — señalado de baja + confirmación**
  - `StatusBadge 'baja'` + texto en tabla y resumen; `CreateCampaignConfirmModal` con línea CSV +
    conteo de bajas (`statusCounts.baja`).
- [ ] **F3.4 — `useBulkMessaging`**
  - `useSegmentRecipients` acepta el input completo + view (query keys incluyen TODO el input —
    lección `bulkSegmentRecipientsKey`, `useBulkMessaging.ts:39-40`).

## Batch F4 — FE: integración + gate

- [ ] **F4.1 — test de integración del composer**
  - Flujo completo: cargar CSV → preview (mock del contrato nuevo) → excluidos visibles →
    confirmar → payload `manualContacts` correcto.
- [ ] **F4.2 — gate FE completo** (suite entera + typecheck)
- [ ] **F4.3 — E2E en vivo antes de merge** (lección e2e-envelope-mock-mismatch: los mocks no
  cazan mismatches de envelope — probar contra el BE real el shape de `view:'excluded'` y el
  create solo-CSV).
