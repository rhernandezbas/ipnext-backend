export type SuggestionKind = 'DEVICE' | 'MATERIAL';
export type SuggestionStatus = 'pending' | 'confirmed' | 'discarded';

/**
 * Staging per task — what we scraped/OCR'd, shown to the operator as checkboxes.
 * NEVER touches the contract on its own; the operator confirms each into a
 * ServiceInstalledItem. One suggestion = one device (or one material line).
 */
export interface TaskInventorySuggestion {
  id: string;
  taskId: string;
  kind: SuggestionKind;
  /** DEVICE: ONU | ROUTER | ANTENA | REPETIDOR | OTROS (del label de la pregunta). */
  deviceType: string | null;
  /** DEVICE: tipo que el modelo de visión infirió de la foto (badge "qwen sugiere"), o null. */
  qwenDeviceType: string | null;
  serialNumber: string | null;
  mac: string | null;
  /** MATERIAL: free-text description. */
  materialDesc: string | null;
  quantity: number | null;
  unit: string | null;
  /** OCR | ICLASS_MATERIAL. */
  source: string;
  photoUrl: string | null;
  status: SuggestionStatus;
  /** Set to the ServiceInstalledItem id once confirmed. */
  confirmedItemId: string | null;
  createdAt: string;
}
