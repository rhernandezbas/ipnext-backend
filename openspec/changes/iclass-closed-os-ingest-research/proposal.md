<!-- generated from engram topic_key: sdd/iclass-closed-os-ingest-research/proposal -->
**What**: Proposal for ingesting closed IClass Service Orders into ipnext-backend (mirror of technician work product). Companion to `sdd/iclass-closed-os-ingest-research/explore`.

**Why**: We send tasks TO IClass already (see commit history: SendTaskToIClass, project→soType mapping). Closing the loop means we pull closed SOs back and persist what the technician did (materials, photos-by-reference, GPS, result code, timeline). This unlocks reporting, billing reconciliation, and customer-facing service history.

---

### Endpoints + query strategy

**Polling pattern (cron job):**
1. Every N minutes (suggest 5-15 min), run an `ingestRecentlyClosedSOs` job.
2. Maintain a `lastSyncedUpdatedAt` watermark per cluster.
3. Window query (max 30 days, but in steady state ~30 min lookback with overlap):
   `GET /serviceorders?clusterName=IPNEXT INTERNET&updatedDate_begin={watermark-5min}&updatedDate_end={now}&pagesize=60`.
4. Paginate while `hasMoreElements`.
5. For each SO with `status.id === 7` (Concluida):
   - Upsert by `id` (IClass numeric) — that is the stable PK.
   - If we already have it with same `alteradoPor.data`, skip (idempotency).
   - Otherwise fetch detail `GET /serviceorders/{id}` and the sub-resources in this order: `history`, `checklist`, `materials`, `equipments`, `equipments/history`, `procedures`, `expenses`. Skip `environments` / `adresses/equipments` unless explicitly needed.
6. Backoff between sub-resource calls (e.g. 300-500ms) to avoid the rate-limit message "Espere um pouco antes de fazer outra requisição".
7. Bootstrap: initial backfill is window-walking in 25-day slices (leave 5-day safety margin under the 30-day cap).

**No webhooks** — polling is the only viable strategy (verified: zero hook paths in v2 OpenAPI).

**Auxiliary catalogs** (refresh daily, low churn):
- `/serviceordertypes` → cache `id, descricao, resumoTipoOs`.
- `/serviceordertypes/{id}/resultcodes` → cache `{codigo, tipo, modeloPesquisa, obrigatoriedadeAssinatura}` so we can join `motivoFechamento` → result-code semantics.

---

### Minimum useful payload to mirror

By category:

**Identity / FK**
- `iclassId` (PK, from `id`), `iclassCodigo` (`codigo`, often equal to id), `iclassSoTypeId`, `iclassSoTypeDescription`, `iclassClusterName`, `iclassNodeCode`, `iclassThirdPartyCode`.
- Link to internal `ScheduledTask` / `Project`: store the `iclassCodigo` and reverse-lookup our local task by it (we already send the soCode when creating the SO).

**Customer + address**
- `customerCode` (from `contrato.codigo`), `customerName` (`contrato.nomeTitular`).
- `address.codigo`, `address.logradouro`, `address.cidade`, `address.pais`, `address.latitude`, `address.longitude`.

**Lifecycle timestamps**
- `createdAt` (`criadoPor.data`), `lastModifiedAt` (`alteradoPor.data`), `scheduledFor` (`dataAgendamento`), `requestedAt` (`dataSolicitacao`), `availableAt` (`dataDisponibilidade`), `serviceStartedAt`, `serviceEndedAt` (when present).
- `closedAt` = derive from history entry with `statusOS.codigo === '7'` (the v2 has no top-level `closeDate` field in real responses).
- `firstClosedAt` = history entry with `statusOS.codigo === '4'` (FECHADA — technician's close).
- `approvedAt` = history entry with `statusOS.codigo === '50'` → next transition to 7.

**Closure result**
- `resultCodeName` (`motivoFechamento`).
- `resultCodeType` (joined from cached result-codes catalog: Sucesso / Falha / etc.).
- `closedByLogin`, `closedByName` (prefer `alteradoPor`; fall back to `fechadoPor`).
- `closeLatitude`, `closeLongitude`, `closeGpsAt` (from `coordenadasFechamento` — nullable).
- `billingAmount` (`valorCobranca`).
- `technicianNote` (`obsEquipe`).
- `internalNote` (`obs`).
- `commentary` (`comentario` — append-only timestamped log).

**Crew**
- `teamLogin` (`equipe.login`), `teamTechnicianName` (`equipe.tecnico`), `teamPhone` (`equipe.fone1`), `teamEmail`.

**Status timeline** (separate table; one-to-many)
- `historyEntries[]`: `{ iclassOsStatusId, occurredAt, statusCode (string '7'/'4'/...), statusDescription, durationMinutes (tempoStatus), teamLogin, commentary }`.

**Checklist** (separate table; one-to-many → checklist; nested → answers)
- `surveyId` (`pesquisaId`), `surveyAt` (`dataPesquisa`).
- `answers[]`: `{ questionId, questionText, questionType ('Texto'|'Foto'|...), answerOrder, answerText (nullable for photos) }`.
- IMPORTANT: persist a `photoMissing: true` flag for `tipoPergunta === 'Foto'` answers — IClass v2 does NOT return photo URLs. Surface this to UI so users know they have to log into IClass portal to see photos.

**Materials / Equipments** (optional, almost always empty in IPNEXT data)
- `materials[]`: `{ iclassOsMaterialId, qty, unitValue, totalValue, materialCode, materialDescription }`.
- `equipments[]`: `{ iclassOsId, serial, mac, modelDescription, type ('install'|'remove'), occurredAt }`.

**Skip / TBD**
- Procedures, expenses, environments: schemas exist but empty in real data. Defer until product asks for them.
- Photos and signatures: NOT EXPOSED by v2 API — out of scope for ingest. Document the gap.

---

### Prisma model sketch

```prisma
model IClassServiceOrder {
  id                   String    @id @default(cuid())
  iclassId             BigInt    @unique // numeric PK from IClass
  iclassCodigo         String    @unique
  clusterName          String
  thirdPartyCode       String?
  nodeCode             String?
  soTypeId             BigInt?
  soTypeDescription    String?

  customerCode         String?
  customerName         String?
  addressCode          String?
  addressLine          String?
  addressCity          String?
  addressCountry       String?
  addressLat           Float?
  addressLng           Float?

  statusCode           String    // '7' for terminal Concluida
  statusDescription    String

  requestedAt          DateTime?
  scheduledFor         DateTime?
  availableAt          DateTime?
  serviceStartedAt     DateTime?
  serviceEndedAt       DateTime?
  firstClosedAt        DateTime?  // status 4 transition
  approvedAt           DateTime?  // status 50 transition
  closedAt             DateTime?  // status 7 transition (final)

  resultCodeName       String?    // motivoFechamento
  resultCodeType       String?    // joined from catalog (Sucesso/Falha)
  closedByLogin        String?
  closedByName         String?
  closeLatitude        Float?
  closeLongitude       Float?
  closeGpsAt           DateTime?
  billingAmount        Decimal?   @db.Decimal(12,2)

  technicianNote       String?    @db.Text  // obsEquipe
  internalNote         String?    @db.Text  // obs
  commentaryLog        String?    @db.Text  // raw comentario blob

  teamLogin            String?
  teamTechnicianName   String?
  teamPhone            String?
  teamEmail            String?

  // link back to our task (set during SendTaskToIClass)
  scheduledTaskId      String?    @unique
  scheduledTask        ScheduledTask? @relation(fields: [scheduledTaskId], references: [id])

  iclassCreatedAt      DateTime?
  iclassUpdatedAt      DateTime?  // alteradoPor.data — idempotency key
  ingestedAt           DateTime   @default(now())
  rawDetail            Json       // full SO detail snapshot for forensics

  history              IClassSoStatusHistory[]
  checklists           IClassSoChecklist[]
  materials            IClassSoMaterial[]
  equipmentsEvents     IClassSoEquipmentEvent[]

  @@index([clusterName, closedAt])
  @@index([customerCode])
  @@index([iclassUpdatedAt])
}

model IClassSoStatusHistory {
  id                String   @id @default(cuid())
  serviceOrderId    String
  serviceOrder      IClassServiceOrder @relation(fields:[serviceOrderId],references:[id], onDelete: Cascade)
  iclassOsStatusId  BigInt   @unique
  occurredAt        DateTime
  statusCode        String
  statusDescription String
  durationMinutes   Int?
  teamLogin         String?
  commentary        String?  @db.Text
  @@index([serviceOrderId, occurredAt])
}

model IClassSoChecklist {
  id              String   @id @default(cuid())
  serviceOrderId  String
  serviceOrder    IClassServiceOrder @relation(fields:[serviceOrderId],references:[id], onDelete: Cascade)
  iclassSurveyId  BigInt   @unique
  surveyAt        DateTime?
  answers         IClassSoChecklistAnswer[]
}

model IClassSoChecklistAnswer {
  id            String   @id @default(cuid())
  checklistId   String
  checklist     IClassSoChecklist @relation(fields:[checklistId],references:[id], onDelete: Cascade)
  questionId    BigInt
  questionText  String   @db.Text
  questionType  String   // 'Texto' | 'Foto' | ...
  answerOrder   Int
  answerText    String?  @db.Text
  photoMissing  Boolean  @default(false) // true when questionType=Foto (v2 doesn't return URLs)
  @@index([checklistId, answerOrder])
}

model IClassSoMaterial {
  id              String   @id @default(cuid())
  serviceOrderId  String
  serviceOrder    IClassServiceOrder @relation(fields:[serviceOrderId],references:[id], onDelete: Cascade)
  iclassOsMaterialId BigInt @unique
  materialCode    String?
  materialDescription String?
  qty             Decimal  @db.Decimal(12,4)
  unitValue       Decimal? @db.Decimal(12,2)
  totalValue      Decimal? @db.Decimal(12,2)
}

model IClassSoEquipmentEvent {
  id              String   @id @default(cuid())
  serviceOrderId  String
  serviceOrder    IClassServiceOrder @relation(fields:[serviceOrderId],references:[id], onDelete: Cascade)
  occurredAt      DateTime?
  type            String?  // install/remove/move
  serialNumber    String?
  mac             String?
  patrimonialNo   String?
  modelDescription String?
}
```

### Polling vs webhook
- **No webhooks** in IClass v2 (verified). Polling required.
- Suggested cadence: every 10 minutes with a 30-minute overlap window (cheap, idempotent via `iclassUpdatedAt`).
- Bootstrap backfill: walk 25-day windows backward, oldest → newest, persist watermark per cluster.

### Estimated complexity
- **Adapter** (`infrastructure/adapters/iclass/IClassClient` extension): +3 methods (`listClosedSOs`, `getSODetail`, plus a fan-out helper) — ~150 LOC.
- **Catalog cache** (`PrismaIClassResultCodeCatalog` keyed by SO type id): ~80 LOC + sync use case.
- **Ports** (`ClosedServiceOrderRepository`, `IClassClient` interface widening): ~40 LOC.
- **Use case** (`IngestClosedServiceOrders`): orchestrates list → for each → detail → subresources → map → upsert. ~250 LOC.
- **Mapper**: IClass DTOs → domain entities. ~200 LOC (lots of fields).
- **Prisma adapters** for the 5 new tables: ~250 LOC.
- **Migration**: 1 file, 5 tables.
- **Cron entrypoint**: 1 file, ~40 LOC (reuse existing scheduler).
- **Tests** (in-memory adapter + use case): ~400 LOC.

Total: ~1.4k LOC + migration. **Medium-large change.** 2-3 days for one engineer with the IClass adapter already in place.

### Risks
- Rate limiting is undocumented; first deploy needs cautious concurrency (sequential per SO is safest).
- IPNEXT cluster appears to expose ONLY closed SOs (status 7). If that changes (e.g. IPNEXT starts exposing in-flight SOs), the ingest logic should still filter to `status.id===7` to keep semantics stable.
- The 30-day window cap means we cannot do a single-shot backfill of >30 days — backfill must be windowed.
- Photos/signatures gap: customer/sales may expect to see install photos. Set expectations: link out to IClass portal.
- `dataInicioAtendimento`/`dataFimAtendimento` are nullable in real data; derive from history transitions when missing.

### Recommendation
**Build it.** Adapter is already in repo for the write path; this just adds the read path. Start with the minimum mirror (SO + history + checklist + result-code catalog), defer materials/equipments until product validates demand. Polling job behind feature flag with watermark in DB.
