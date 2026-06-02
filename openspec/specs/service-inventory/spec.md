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

- Crea un `ServiceInstalledItem` asociado al `Service` de la task (`task.serviceId`), `source` heredado, `sourceTaskId`, `addedByUserId` del auth, `confirmedAt`.
- Marca la sugerencia `confirmed` y guarda `confirmedItemId`.
- **SCEN-CF-1**: confirmar una sugerencia DEVICE → 1 `ServiceInstalledItem` con `serialNumber`/`mac` singulares.
- **SCEN-CF-2**: confirmar 2 sugerencias ROUTER → **2 filas** `ServiceInstalledItem` (una por equipo).
- **SCEN-CF-3**: task sin `serviceId` → `409 { code: "TASK_HAS_NO_SERVICE" }`.
- **SCEN-CF-4**: confirmar una ya confirmada → `409 { code: "SUGGESTION_ALREADY_CONFIRMED" }`.

## Capability: manage-installed-items

- **GET /api/services/:serviceId/inventory** → `ServiceInstalledItem[]` del contrato.
- **POST /api/services/:serviceId/inventory** → alta manual (`type`, `serialNumber?`, `mac?`, `model?`, `notes?`), `source:'MANUAL'`. (Cubre el "agregar SN al servicio" para equipos que el OCR no captó.)
- **PATCH /api/services/:serviceId/inventory/:itemId** → editar (`status` active/removed/replaced, notes…).
- **GET /api/scheduling/:taskId/inventory/suggestions** → sugerencias de la task (para los checkboxes).
- **POST /api/scheduling/:taskId/inventory/suggestions/:suggestionId/discard** → marca `discarded`.
- **SCEN-MI-1**: alta manual de un 2do router → coexiste con el del OCR (2 filas).

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
  source: 'OCR' | 'ICLASS_MATERIAL';
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
  get(id: string): Promise<TaskInventorySuggestion | null>;
  setStatus(id: string, status: string, confirmedItemId?: string): Promise<TaskInventorySuggestion | null>;
}
```
