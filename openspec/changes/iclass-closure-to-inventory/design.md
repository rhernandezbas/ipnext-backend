# Design: IClass Closure → Auto-Comment + Inventory per Contract

## Data flow

```
IngestClosedServiceOrders (existe)  ── por cada OS cerrada que matchea una task ──┐
                                                                                  │
  [A] API v2 getServiceOrderChecklists(osId)  → preguntas {pesqPerguntaId, ordem, tipoPergunta, resposta}
  [A] IClassPortalClient.parseOSDetail(html)  → fotos {ordem, photoUrl, fileName} + firma
        └─ correlación por `ordem`: answer(tipo=Foto).photoUrl = foto del SEAM en esa posición
        │
        ├─[D] PostClosureComment → TaskComment legible (Q&A texto) + fotos como attachments. Idempotente.
        │
        └─[B] ExtractDeviceInfoFromPhoto (solo preguntas cuyo texto matchea equipo)
               preprocess(Pillow: rotate+crop+upscale) → gemma3:12b → OcrExtraction {sn, mac, type, confidence}
               │
               └─[C] BuildInventorySuggestions → TaskInventorySuggestion[] (DEVICE desde OCR, MATERIAL desde IClassSoMaterial)
                      │  estado pending — NO toca el contrato
                      ▼  (operador, vía endpoint) ConfirmInventorySuggestion
               [E] ServiceInstalledItem  → asociado al Service (contrato)
```

## Two-layer parser (resiliencia)

El parser del SEAM (Capa 1) es **estructural y tonto**: por cada pregunta del HTML, clasifica por estructura (`<textbox>` → TEXTO; link "Imagen"+S3 → FOTO; "No Disponible" → `photoMissing`). Nunca se rompe ante un tipo de OS nuevo. La **Capa 2** (enriquecimiento) lee `questionText` por keywords para decidir qué fotos van a OCR y cómo tipar el equipo:

- `/MAC.*SN.*ROUTER/i` → `ROUTER`
- `/MAC.*SN.*ANTENA/i` → `ANTENA`
- `/ONU|GPON/i` → `ONU`
- sin match conocido → `OTROS` + revisión manual (no crashea).

## OCR pipeline (F4)

Verificado: el modelo NO es el cuello de botella, el **preprocesamiento** lo es.

1. Descargar la foto del bucket S3 (público).
2. **Localizar la etiqueta** (la parte difícil): VLM en 2 pasos (gemma3 ubica bbox → recortar) — punto de iteración. Fallback: imagen completa rotada+upscale.
3. Deskew/rotación (las fotos pueden venir invertidas).
4. Upscale (LANCZOS) del recorte.
5. `gemma3:12b` con prompt estricto JSON `{mac, sn}`, `temperature:0`, "no inventar caracteres, null si ilegible".
6. `confidence` heurística; bajo umbral → la sugerencia queda `pending` para revisión humana de todas formas (es el comportamiento por defecto).

`OcrExtraction` guarda el raw output para auditoría. Provider abstraído tras un port `DevicePhotoOcr` (hoy Ollama; mañana Textract/Vision sin tocar el use case).

## Correlation key — `ordem`

La API v2 numera las preguntas con `resposta.ordem` (0-based). El HTML del SEAM las renderiza en ese mismo orden. Por cada pregunta `tipoPergunta=5` (Foto) en la API, se toma la foto del SEAM en la misma posición `ordem`. Resuelve la ambigüedad de labels repetidos (ej. fibra con 7 "ADJUNTAR FOTO…" idénticas).

## Models (Prisma)

```prisma
// CHANGE
model IClassSoChecklistAnswer {
  // ...existente...
  photoUrl String?   // NUEVO — URL S3 de la foto (correlacionada por ordem desde el SEAM)
}

// NUEVO
model OcrExtraction {
  id             String   @id @default(uuid())
  photoUrl       String
  serviceOrderId String?
  sourceTaskId   String?
  deviceType     String?  // ROUTER | ANTENA | ONU | REPETIDOR | OTROS
  sn             String?
  mac            String?
  confidence     Float?
  rawOutput      String?  @db.Text
  provider       String   @default("ollama:gemma3:12b")
  createdAt      DateTime @default(now())
  @@index([sourceTaskId])
}

// NUEVO — staging por tarea (lo que el operador ve como checkboxes)
model TaskInventorySuggestion {
  id             String        @id @default(uuid())
  taskId         String
  task           ScheduledTask @relation(fields: [taskId], references: [id], onDelete: Cascade)
  kind           String        // DEVICE | MATERIAL
  deviceType     String?       // si DEVICE
  serialNumber   String?
  mac            String?
  materialDesc   String?       // si MATERIAL
  quantity       Float?        // si MATERIAL
  unit           String?
  source         String        // OCR | ICLASS_MATERIAL
  photoUrl       String?
  status         String        @default("pending") // pending | confirmed | discarded
  confirmedItemId String?      // FK lógica al ServiceInstalledItem creado
  createdAt      DateTime      @default(now())
  @@index([taskId, status])
}

// NUEVO — confirmado, en el contrato
model ServiceInstalledItem {
  id            String   @id @default(uuid())
  serviceId     String
  service       Service  @relation(fields: [serviceId], references: [id], onDelete: Cascade)
  type          String   // ONU | ROUTER | ANTENA | REPETIDOR | OTROS
  serialNumber  String?
  mac           String?
  model         String?
  source        String   // OCR | MANUAL | ICLASS
  sourceTaskId  String?
  addedByUserId String?
  confirmedAt   DateTime?
  status        String   @default("active") // active | removed | replaced
  notes         String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@index([serviceId])
  @@index([serialNumber])
}
```

`Service` gana la back-relation `installedItems ServiceInstalledItem[]`.

## Hexagonal mapping

- **Ports** (`domain/ports/`): `IClassPortalPort` (scraper), `DevicePhotoOcr` (OCR), `ServiceInventoryRepository`, `InventorySuggestionRepository`, `OcrExtractionRepository`. Reusa `TaskCommentRepository` existente para [D].
- **Adapters** (`infrastructure/adapters/`): `IClassPortalClient` (SEAM/HTML), `OllamaDevicePhotoOcr`, `Prisma*Repository` + `InMemory*Repository`.
- **Use cases** (`application/use-cases/`): `PostClosureComment`, `ExtractDeviceInfoFromPhoto`, `BuildInventorySuggestions`, `ConfirmInventorySuggestion`, `AddInstalledItemManually`, `DiscardInventorySuggestion`, `ListServiceInstalledItems`, `ListTaskInventorySuggestions`.
- Orquestación: extender `IngestClosedServiceOrders.processSummary` (o un hook posterior) para disparar [A][D][B][C] tras `closed.upsert`. La confirmación [E] es API-driven (operador), desacoplada del cron.

## Idempotencia

- Auto-comment [D]: no doble-postear. Guard por `(taskId, sourceServiceOrderId)` — buscar un comment del autor "Sistema IClass" para esa OS antes de crear.
- Sugerencias [C]: upsert por `(taskId, kind, serialNumber|materialDesc)` para que un re-ingest no duplique.
- OCR [B]: idempotente por `photoUrl`.

## Riesgos

- HTML del SEAM puede cambiar → tests de parser sobre snapshots HTML fijos; alerta si el parser no encuentra secciones esperadas.
- Sesión del portal expira → re-login transparente + caché de cookie en `IClassPortalClient`.
- Rate-limit del portal → backoff + jitter (igual que el `IClassClient` de API).
- Localización de etiqueta para OCR → el caso difícil; soft-fail a `pending` siempre deja la red de seguridad humana.
- `gemma3` en prod sin GPU → corre en cron de fondo, volumen bajo; definir host de Ollama.
