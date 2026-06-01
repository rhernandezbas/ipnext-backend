/** Raw OCR output for one device photo. */
export interface DeviceOcrResult {
  /** Serial number, or null if unreadable (never invent characters). */
  sn: string | null;
  /** MAC address, or null if unreadable. */
  mac: string | null;
  /** Heuristic confidence 0..1, or null. */
  confidence: number | null;
  /** Raw provider output (audit). */
  rawOutput: string;
}

/**
 * OCR provider for device-label photos. The adapter owns the preprocessing
 * (download, deskew/rotate, crop the label, upscale) and the model call —
 * verified that a local vision model (Ollama gemma3) reads SN/MAC reliably ONLY
 * after preprocessing. Provider is swappable (Ollama today, Textract/Vision later).
 */
export interface DevicePhotoOcr {
  /** Provider id, persisted on the extraction (e.g. "ollama:gemma3:12b"). */
  readonly provider: string;
  extract(photoUrl: string, deviceTypeHint?: string): Promise<DeviceOcrResult>;
}
