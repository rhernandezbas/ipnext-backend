import { Jimp, JimpMime } from 'jimp';
import { DevicePhotoOcr, DeviceOcrResult } from '@domain/ports/DevicePhotoOcr';
import { finalizeOcrResult } from './finalizeOcrResult';

const BASE_DEVICE_TYPES = ['ONU', 'ROUTER', 'ANTENA', 'REPETIDOR', 'OTROS'];

function buildPrompt(typeNames: string[]): string {
  const types = typeNames.length > 0 ? typeNames : BASE_DEVICE_TYPES;
  const union = types.join('|');
  return (
    'This is a photo of a network device label. ' +
    'Extract the MAC address, the Serial Number (S/N), and classify the device type. ' +
    `Respond strictly as JSON: {"mac":"...","sn":"...","device_type":"${union}"}. ` +
    'Read carefully character by character. Do not invent characters; use null if unreadable. ' +
    `For device_type use exactly one of: ${types.join(', ')}.`
  );
}

export interface OllamaOcrConfig {
  baseUrl: string;
  model: string;
  /** Max wait for the model inference (ms). Default 120s. Abort → soft-fail. */
  timeoutMs?: number;
  /** Max wait to download the photo (ms). Default 30s. */
  downloadTimeoutMs?: number;
  /**
   * Async supplier of active device-type names from the catalog.
   * When provided the prompt is built dynamically at extract-time.
   * Falls back to the 5 base names when not provided or when the call fails.
   */
  deviceTypeNames?: () => Promise<string[]>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Local OCR via an Ollama vision model (gemma3). Verified: the model reads
 * SN/MAC reliably from a cropped, upright label. v1 preprocessing here is
 * download + upscale + greyscale/normalize; label localization/deskew (which
 * lifts accuracy to the verified level) is the tuning iteration — until then
 * low-confidence results stay `pending` for manual review (the pipeline's
 * safety net), so an imperfect read never corrupts the contract.
 */
export class OllamaDevicePhotoOcr implements DevicePhotoOcr {
  readonly provider: string;
  private readonly timeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly deviceTypeNames?: () => Promise<string[]>;

  constructor(private readonly cfg: OllamaOcrConfig) {
    this.provider = `ollama:${cfg.model}`;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.downloadTimeoutMs = cfg.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    this.deviceTypeNames = cfg.deviceTypeNames;
  }

  async extract(photoUrl: string): Promise<DeviceOcrResult> {
    // Any failure (download, model timeout/abort, Ollama down) soft-fails to a
    // null read persisted for audit — never throws, never blocks the cron.
    try {
      const typeNames = this.deviceTypeNames ? await this.deviceTypeNames().catch(() => BASE_DEVICE_TYPES) : BASE_DEVICE_TYPES;
      const prompt = buildPrompt(typeNames);
      const imageB64 = await this.preprocess(photoUrl);
      const raw = await this.ask(imageB64, prompt);
      return finalizeOcrResult(raw);
    } catch (e) {
      // Technical failure (download/timeout/Ollama down) → mark `failed` so the
      // caller does not persist/cache it; a later reprocess re-runs the model.
      return { sn: null, mac: null, confidence: 0, rawOutput: `ocr-error: ${(e as Error).message}`, failed: true };
    }
  }

  private async preprocess(url: string): Promise<string> {
    const res = await fetch(url, { signal: AbortSignal.timeout(this.downloadTimeoutMs) });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const image = await Jimp.read(buf);
    image.scale(2); // upscale — the label is a small region of the frame
    image.greyscale();
    image.normalize(); // stretch contrast to aid the model
    const out = await image.getBuffer(JimpMime.jpeg);
    return out.toString('base64');
  }

  private async ask(imageB64: string, prompt: string): Promise<string> {
    const res = await fetch(`${this.cfg.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.cfg.model,
        prompt,
        images: [imageB64],
        stream: false,
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = (await res.json()) as { response?: string };
    return json.response ?? '';
  }
}
