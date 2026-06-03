import { InventorySuggestionRepository } from '@domain/ports/InventorySuggestionRepository';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';
import { OcrExtraction } from '@domain/entities/ocr-extraction';
import { SoMaterial } from '@domain/entities/iclass-closed-order';
import { randomUUID } from 'crypto';

export interface BuildInventorySuggestionsInput {
  taskId: string;
  /** DEVICE candidates — one per OCR'd device photo. */
  extractions: OcrExtraction[];
  /** MATERIAL candidates — from the mirrored SO. */
  materials: SoMaterial[];
}

/**
 * Builds the per-task inventory staging from OCR device extractions + IClass
 * materials. Everything lands as `pending` — this NEVER writes a
 * ServiceInstalledItem (that needs the operator's confirmation). Idempotent via
 * the repository's natural-key upsert (re-ingesting does not duplicate).
 */
export class BuildInventorySuggestions {
  constructor(private readonly repo: InventorySuggestionRepository) {}

  async execute(input: BuildInventorySuggestionsInput): Promise<TaskInventorySuggestion[]> {
    const out: TaskInventorySuggestion[] = [];

    for (const e of input.extractions) {
      out.push(await this.repo.upsert(this.deviceSuggestion(input.taskId, e)));
    }
    for (const m of input.materials) {
      if (!m.materialDescription) continue;
      out.push(await this.repo.upsert(this.materialSuggestion(input.taskId, m)));
    }
    return out;
  }

  private deviceSuggestion(taskId: string, e: OcrExtraction): TaskInventorySuggestion {
    return {
      id: randomUUID(),
      taskId,
      kind: 'DEVICE',
      deviceType: e.deviceType,
      qwenDeviceType: e.qwenDeviceType ?? null,
      serialNumber: e.sn,
      mac: e.mac,
      materialDesc: null,
      quantity: null,
      unit: null,
      source: 'OCR',
      photoUrl: e.photoUrl,
      status: 'pending',
      confirmedItemId: null,
      createdAt: new Date().toISOString(),
    };
  }

  private materialSuggestion(taskId: string, m: SoMaterial): TaskInventorySuggestion {
    return {
      id: randomUUID(),
      taskId,
      kind: 'MATERIAL',
      deviceType: null,
      qwenDeviceType: null,
      serialNumber: null,
      mac: null,
      materialDesc: m.materialDescription,
      quantity: m.qty,
      unit: null,
      source: 'ICLASS_MATERIAL',
      photoUrl: null,
      status: 'pending',
      confirmedItemId: null,
      createdAt: new Date().toISOString(),
    };
  }
}
