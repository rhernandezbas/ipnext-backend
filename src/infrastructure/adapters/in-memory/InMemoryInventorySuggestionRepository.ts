import { InventorySuggestionRepository } from '@domain/ports/InventorySuggestionRepository';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';

/**
 * Clave natural para upsert idempotente: task + kind + source + (sn|mac|materialDesc).
 * El `source` fue agregado para que un upsert OCR nunca clobber una fila MANUAL
 * que comparte el mismo SN/MAC, y viceversa.
 */
function naturalKey(s: TaskInventorySuggestion): string {
  return `${s.taskId}::${s.kind}::${s.source}::${s.serialNumber ?? s.mac ?? s.materialDesc ?? ''}`;
}

export class InMemoryInventorySuggestionRepository implements InventorySuggestionRepository {
  readonly store = new Map<string, TaskInventorySuggestion>(); // keyed by id
  private readonly byNatural = new Map<string, string>(); // naturalKey → id

  async listByTask(taskId: string): Promise<TaskInventorySuggestion[]> {
    return Array.from(this.store.values()).filter(s => s.taskId === taskId);
  }

  async hasDeviceForTask(taskId: string): Promise<boolean> {
    return Array.from(this.store.values()).some(
      s => s.taskId === taskId && s.kind === 'DEVICE' && s.status !== 'discarded',
    );
  }

  async upsert(suggestion: TaskInventorySuggestion): Promise<TaskInventorySuggestion> {
    const key = naturalKey(suggestion);
    const existingId = this.byNatural.get(key);
    if (existingId) {
      const existing = this.store.get(existingId)!;
      // Preserve identity + a human decision already made; refresh scraped fields.
      const merged: TaskInventorySuggestion = {
        ...existing,
        deviceType: suggestion.deviceType,
        serialNumber: suggestion.serialNumber,
        mac: suggestion.mac,
        materialDesc: suggestion.materialDesc,
        quantity: suggestion.quantity,
        unit: suggestion.unit,
        photoUrl: suggestion.photoUrl,
      };
      this.store.set(existingId, merged);
      return merged;
    }
    this.store.set(suggestion.id, suggestion);
    this.byNatural.set(key, suggestion.id);
    return suggestion;
  }

  /** Plain insert sin dedup. Las sugerencias MANUAL nunca modifican filas OCR. */
  async create(suggestion: TaskInventorySuggestion): Promise<TaskInventorySuggestion> {
    this.store.set(suggestion.id, suggestion);
    // Intencionalmente NO se registra en byNatural para que un upsert posterior
    // de OCR con el mismo SN/MAC no encuentre esta fila y la sobreescriba.
    return suggestion;
  }

  async get(id: string): Promise<TaskInventorySuggestion | null> {
    return this.store.get(id) ?? null;
  }

  async setStatus(
    id: string,
    status: TaskInventorySuggestion['status'],
    confirmedItemId?: string,
    deviceType?: string,
  ): Promise<TaskInventorySuggestion | null> {
    const s = this.store.get(id);
    if (!s) return null;
    const updated = {
      ...s,
      status,
      confirmedItemId: confirmedItemId ?? s.confirmedItemId,
      deviceType: deviceType ?? s.deviceType,
    };
    this.store.set(id, updated);
    return updated;
  }
}
