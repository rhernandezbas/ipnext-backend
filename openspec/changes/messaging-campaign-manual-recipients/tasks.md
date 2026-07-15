# Tasks — messaging-campaign-manual-recipients

**Change**: messaging-campaign-manual-recipients · **Phase**: tasks · **Project**: ipnext-backend
**TDD**: test que falla PRIMERO, después el mínimo código, después refactor. Correr SOLO los archivos
de test afectados durante el loop (el gate completo lo corre el orquestador).

---

- [x] **T1 — `phone` en el search de `buildClientListWhere`** (MAN-6)
  - Test: `PrismaCustomerRepository.list.segment.test.ts` — el OR del search incluye `phone`.
  - Código: `buildClientListWhere` suma `{ phone: { contains, mode:'insensitive' } }` al OR.

- [x] **T2 — DTO `manualClientIds`** (MAN-1)
  - `CreateCampaignInput.manualClientIds?: string[]` + `PreviewSegmentInput.manualClientIds?: string[]`.

- [x] **T3 — `CreateCampaign` resuelve la unión deduplicada** (MAN-1)
  - Port nuevo `ManualRecipientSource` + impl Prisma + helper `resolveCombinedRecipients`.
  - Tests: solo-segmento (no-regresión), solo-manual, segmento+manual, overlap dedup.

- [x] **T4 — guard `assertHasRecipients`** (MAN-2)
  - `segmentHasCriteria` (predicado) extraído; `assertSegmentIsFiltered` intacto.
  - Tests: vacío-total → rechazada; solo-manual → aceptada.

- [x] **T5 — fail-loud `ManualRecipientsNotFoundError`** (MAN-3)
  - Error tipado + `statusMap` 422 + `domainErrorToCode.missingClientIds` + `errorHandler`.
  - Tests: id inexistente → error con `missingClientIds`; existentes → ok.

- [x] **T6 — preview cuenta la unión sin doble-contar** (MAN-5)
  - `PreviewCampaignSegment` acepta `manualClientIds` + `manualRecipientSource` opcional.
  - Test: overlap → count = unión, no doble.

- [x] **T7 — wiring ruta `POST /campaigns` + `app.ts`** (MAN-1)
  - Ruta parsea `manualClientIds` del body; `app.ts` inyecta `customerAdapter` como manual source.
  - Test seam: POST con manualClientIds materializa recipients + DTO curado.

- [x] **T4-compliance — manual opt-out excluido** (MAN-4)
  - Test: manualClientId opt-out se excluye sin error.

---

## Fix wave (review adversarial) — TDD por fix (test rojo → verde → refactor)

- [x] **FIX-1 [MEDIUM] — dedup de la unión también por TELÉFONO normalizado (cross-set)**
  - Problema: la unión colapsaba SOLO por `clientId` → segmento A(phone X) + manual B(clientId≠A, phone X)
    materializaba 2 recipients → 2 WhatsApp al mismo número (y resucitaba un colapsado por SEG-3).
  - Código: `resolveCombinedRecipients` colapsa la unión por `phoneNormalized` (misma clave que
    `resolveRecipients`); segmento primero (precedencia), el manual colisionante se EXCLUYE y se cuenta en
    `manualSkipped.duplicatePhone`. Overlap por `clientId` filtrado antes de resolver (no doble-cuenta).
  - Tests: `CreateCampaign.test.ts` — "segmento A(phone X) + manual B (mismo phone) → 1 recipient (gana A)";
    "no-regresión: manual con teléfono distinto sí entra". `PreviewCampaignSegment.test.ts` — cross-set
    duplicate-phone contabilizado en `skipped.duplicatePhone` (compartido con FIX-2 c).

- [x] **FIX-2 [MEDIUM] — el preview RECONCILIA las exclusiones de los manuales**
  - Problema: `skipped` reportaba SOLO las del segmento → operador elige 3, preview dice 2, skipped `{0,0,0}`
    → no reconciliaba.
  - Código: `resolveCombinedRecipients` devuelve `manualSkipped` (excluyendo el overlap por `clientId` con el
    segmento, para no doble-contar); `PreviewCampaignSegment` suma `segmentSkipped + manualSkipped`.
    Semántica documentada en design §Decisión-9 (invariante `count + Σskipped = |S| + |M\S|`).
  - Tests: `PreviewCampaignSegment.test.ts` — (a) solo-manual c2 opt-out → `count=2`, `optedOut=1` (3=2+1);
    (b) manual teléfono inválido → `invalidPhone`; (c) cross-set duplicate-phone → `duplicatePhone`;
    (d) no-regresión segment-only → skipped idéntico.

- [x] **FIX-3 [MEDIUM] — cota superior `MAX_MANUAL_RECIPIENTS` (= 5000)**
  - Problema: lista sin cota → >65535 ids revientan el límite de bind params de Postgres → 500.
  - Código: constante `MAX_MANUAL_RECIPIENTS` + `TooManyManualRecipientsError` (code
    `TOO_MANY_MANUAL_RECIPIENTS` → 422 en `statusMap`); check al inicio de `resolveCombinedRecipients`
    (ANTES de la DB). Rationale del número en design §Decisión-10.
  - Tests: `PreviewCampaignSegment.test.ts` — MAX+1 → `TooManyManualRecipientsError`; exactamente MAX → pasa.
    `messagingBulk.routes.test.ts` — MAX+1 vía HTTP → 422 `TOO_MANY_MANUAL_RECIPIENTS` (no 500), no crea Campaign.

- [x] **FIX-4 [LOW] — `toManualClientIds` fail-loud (no descartar no-strings en silencio)**
  - Problema: filtraba no-strings en silencio → un id como number desaparecía mudo (contra MAN-3).
  - Código: `toManualClientIds` (ruta) → `undefined` = `[]` (solo-segmento, OK); PRESENTE no-array o con
    elemento no-string → `InvalidManualRecipientsError` (code `VALIDATION_ERROR` → 400). Whitespace se sigue
    limpiando (trim, es normalización, NO error).
  - Tests: `messagingBulk.routes.test.ts` — `[123]` → 400; `"abc"` → 400; preview no-array → 400; sin campo →
    201 (solo-segmento); `["  ", "c1"]` → whitespace limpiado, c1 entra.

- [x] **Known-debt documentadas** (design §Known-debt): GET `/segment/preview` ignora `manualClientIds`;
  `manualClientIds` no se persiste en `Campaign` (auditoría manual-vs-segmento); label "segmento" en el
  `EmptySegmentError` del caso manual-only todo-excluido (cosmético).
