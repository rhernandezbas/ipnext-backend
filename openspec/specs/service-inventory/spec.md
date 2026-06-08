# Spec: Service Inventory (suggestions + installed items)

## Capability: extract-device-info

`DevicePhotoOcr.extract(photoUrl, deviceTypeHint?)` → SN/MAC desde una foto de etiqueta.

- Preprocesa (rotar + recortar etiqueta + upscale) antes de inferir.
- `gemma3:12b` vía Ollama, prompt estricto JSON `{mac, sn}`, `temperature:0`.
- Guarda `OcrExtraction` (incl. `rawOutput`, `confidence`, `provider`).
- **SCEN-OCR-1**: foto legible de etiqueta → `{sn, mac}` no nulos, `OcrExtraction` persistida.
- **SCEN-OCR-2**: foto ilegible → `sn/mac` null, `confidence` baja; NO inventa caracteres.
- Solo se procesan preguntas cuyo `questionText` matchea equipo (router/antena/onu); el resto se ignora.

## Capability: build-inventory-suggestions

`BuildInventorySuggestions(taskId)` → puebla `TaskInventorySuggestion[]` (staging), estado `pending`.

- DEVICE: una sugerencia por equipo del OCR (`deviceType`, `serialNumber`, `mac`, `photoUrl`, `source:'OCR'`).
- MATERIAL: una sugerencia por `IClassSoMaterial` (`materialDesc`, `quantity`, `unit`, `source:'ICLASS_MATERIAL'`).
- **SCEN-BS-1**: OCR detecta antena + router → 2 sugerencias DEVICE distintas.
- **SCEN-BS-2 (idempotencia)**: re-correr → no duplica (upsert por `taskId+kind+serialNumber|materialDesc`).
- **SCEN-BS-3**: nada toca `ServiceInstalledItem` en este paso.

## Capability: confirm-inventory-suggestion

**POST /api/scheduling/:taskId/inventory/suggestions/:suggestionId/confirm**

- Creates a `ContractInstalledItem` (or `TaskMaterialConsumption` for MATERIAL kind) associated with the task's service.
- The `source` field on the created item MUST be the suggestion's `source` passed through verbatim: `'OCR'` → `'OCR'`, `'ICLASS_MATERIAL'` → `'ICLASS'`, `'MANUAL'` → `'MANUAL'`.
- Marks the suggestion `confirmed` and saves `confirmedItemId`.
- `addedByUserId` comes from the authenticated user; `confirmedAt` is set to now.

(Previously: source mapping was `suggestion.source === 'OCR' ? 'OCR' : 'ICLASS'`, which incorrectly labelled `MANUAL` suggestions as `ICLASS` on the contract item.)

#### Scenario: SCEN-CF-1 — confirm DEVICE suggestion → installed item

- GIVEN a pending DEVICE suggestion exists for a task with a valid `serviceId`
- WHEN `POST .../confirm` is called
- THEN a `ContractInstalledItem` is created with the suggestion's `serialNumber`, `mac`, and `source` verbatim
- AND the suggestion status becomes `confirmed`

#### Scenario: SCEN-CF-2 — confirm two ROUTER suggestions → two items

- GIVEN two pending DEVICE suggestions of type ROUTER exist for the same task
- WHEN both are confirmed sequentially
- THEN two separate `ContractInstalledItem` rows exist (one per suggestion)

#### Scenario: SCEN-CF-3 — task without serviceId → 409

- GIVEN a pending suggestion exists for a task with no `serviceId`
- WHEN `POST .../confirm` is called
- THEN `409 { code: "TASK_HAS_NO_SERVICE" }`

#### Scenario: SCEN-CF-4 — already confirmed → 409

- GIVEN a suggestion is already `confirmed`
- WHEN `POST .../confirm` is called again
- THEN `409 { code: "SUGGESTION_ALREADY_CONFIRMED" }`

#### Scenario: SCEN-CF-5 — MANUAL suggestion confirmed → source preserved

- GIVEN a pending suggestion with `source='MANUAL'` exists
- WHEN `POST .../confirm` is called
- THEN the created `ContractInstalledItem` has `source='MANUAL'`

#### Scenario: SCEN-CF-6 — OCR suggestion confirmed → source OCR

- GIVEN a pending suggestion with `source='OCR'` exists
- WHEN `POST .../confirm` is called
- THEN the created `ContractInstalledItem` has `source='OCR'`

#### Scenario: SCEN-CF-7 — ICLASS_MATERIAL suggestion confirmed → source ICLASS

- GIVEN a pending suggestion with `source='ICLASS_MATERIAL'` exists
- WHEN `POST .../confirm` is called
- THEN the created `ContractInstalledItem` has `source='ICLASS'`

## Capability: manage-installed-items

- **GET /api/services/:serviceId/inventory** → `ServiceInstalledItem[]` del contrato.
- **POST /api/services/:serviceId/inventory** → alta manual (`type`, `serialNumber?`, `mac?`, `model?`, `notes?`), `source:'MANUAL'`. (Cubre el "agregar SN al servicio" para equipos que el OCR no captó.)
- **PATCH /api/services/:serviceId/inventory/:itemId** → editar (`status` active/removed/replaced, notes…).
- **GET /api/scheduling/:taskId/inventory/suggestions** → sugerencias de la task (para los checkboxes).
- **POST /api/scheduling/:taskId/inventory/suggestions/:suggestionId/discard** → marca `discarded`.
- **SCEN-MI-1**: alta manual de un 2do router → coexiste con el del OCR (2 filas).

## Capability: suggestion-source-enum

The `TaskInventorySuggestion.source` field MUST accept `'MANUAL'` as a valid value in addition to `'OCR'` and `'ICLASS_MATERIAL'`. No DB migration is required (`source` is a plain `String` column). The Prisma schema comment for `source` SHOULD be updated to document `OCR | ICLASS_MATERIAL | MANUAL`.

The `InventorySuggestionRepository` port MUST expose a `create(s: TaskInventorySuggestion): Promise<TaskInventorySuggestion>` method. This method MUST NOT apply natural-key upsert logic — it inserts a new row unconditionally, so MANUAL suggestions never overwrite OCR suggestions sharing the same `serialNumber`/`mac`.

#### Scenario: source field accepts MANUAL

- GIVEN a `TaskInventorySuggestion` is constructed with `source='MANUAL'`
- WHEN it is persisted via `InventorySuggestionRepository.create()`
- THEN the stored row has `source='MANUAL'`

#### Scenario: create() does not clobber upsert rows

- GIVEN an OCR suggestion exists with `taskId=T`, `serialNumber='SN-1'`
- WHEN `create()` is called with a MANUAL suggestion for `taskId=T`, `serialNumber='SN-1'`
- THEN both rows exist independently; the OCR row's `photoUrl` and `qwenDeviceType` are unchanged

## Domain model

```typescript
interface ServiceInstalledItem {
  id: string;
  serviceId: string;
  type: 'ONU' | 'ROUTER' | 'ANTENA' | 'REPETIDOR' | 'OTROS';
  serialNumber: string | null;
  mac: string | null;
  model: string | null;
  source: 'OCR' | 'MANUAL' | 'ICLASS';
  sourceTaskId: string | null;
  addedByUserId: string | null;
  confirmedAt: string | null; // ISO 8601
  status: 'active' | 'removed' | 'replaced';
  notes: string | null;
  createdAt: string;
}

interface TaskInventorySuggestion {
  id: string;
  taskId: string;
  kind: 'DEVICE' | 'MATERIAL';
  deviceType?: 'ONU' | 'ROUTER' | 'ANTENA' | 'REPETIDOR' | 'OTROS' | null;
  serialNumber?: string | null;
  mac?: string | null;
  materialDesc?: string | null;
  quantity?: number | null;
  unit?: string | null;
  source: 'OCR' | 'ICLASS_MATERIAL' | 'MANUAL';
  photoUrl?: string | null;
  status: 'pending' | 'confirmed' | 'discarded';
  confirmedItemId?: string | null;
}
```

## Ports

```typescript
interface DevicePhotoOcr {
  extract(photoUrl: string, deviceTypeHint?: string): Promise<{ sn: string | null; mac: string | null; confidence: number | null; rawOutput: string }>;
}
interface ServiceInventoryRepository {
  listByService(serviceId: string): Promise<ServiceInstalledItem[]>;
  create(item: ServiceInstalledItem): Promise<ServiceInstalledItem>;
  update(id: string, patch: Partial<ServiceInstalledItem>): Promise<ServiceInstalledItem | null>;
}
interface InventorySuggestionRepository {
  listByTask(taskId: string): Promise<TaskInventorySuggestion[]>;
  upsert(s: TaskInventorySuggestion): Promise<TaskInventorySuggestion>;
  create(s: TaskInventorySuggestion): Promise<TaskInventorySuggestion>;
  get(id: string): Promise<TaskInventorySuggestion | null>;
  setStatus(id: string, status: string, confirmedItemId?: string): Promise<TaskInventorySuggestion | null>;
}
```
