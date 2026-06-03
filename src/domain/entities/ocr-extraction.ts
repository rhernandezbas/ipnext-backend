/** Result of running OCR over one checklist photo (SN/MAC of an installed device). */
export interface OcrExtraction {
  id: string;
  /** Source photo URL (S3). Idempotency key — one extraction per photo. */
  photoUrl: string;
  /** Mirrored SO this photo belongs to (optional context). */
  serviceOrderId: string | null;
  /** Local task that installed the device (links the extraction to the work). */
  sourceTaskId: string | null;
  /** Device class inferred from the question label (ROUTER | ANTENA | ONU | ...). */
  deviceType: string | null;
  /** Device class the vision model inferred FROM THE IMAGE (validated enum), or null. Hint/badge — never overrides `deviceType`. */
  qwenDeviceType: string | null;
  /** Extracted serial number, or null if unreadable. */
  sn: string | null;
  /** Extracted MAC address, or null if unreadable. */
  mac: string | null;
  /** Heuristic confidence (0..1), or null. Low → stays for manual review. */
  confidence: number | null;
  /** Raw model/provider output, kept for audit. */
  rawOutput: string | null;
  /** OCR provider id (e.g. "ollama:gemma3:12b"). */
  provider: string;
  createdAt: string;
}
