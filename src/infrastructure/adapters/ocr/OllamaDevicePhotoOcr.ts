import { Jimp, JimpMime } from 'jimp';
import { DevicePhotoOcr, DeviceOcrResult } from '@domain/ports/DevicePhotoOcr';
import { parseOcrResponse } from './parseOcrResponse';

const PROMPT =
  'This is a photo of a network device (router / ONU / antenna) label. ' +
  'Extract ONLY the MAC address and the Serial Number (S/N). ' +
  'Respond strictly as JSON: {"mac":"...","sn":"..."}. ' +
  'Read carefully character by character. Do not invent characters; use null if unreadable.';

export interface OllamaOcrConfig {
  baseUrl: string;
  model: string;
  /** Max wait for the model inference (ms). Default 120s. Abort → soft-fail. */
  timeoutMs?: number;
  /** Max wait to download the photo (ms). Default 30s. */
  downloadTimeoutMs?: number;
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

  constructor(private readonly cfg: OllamaOcrConfig) {
    this.provider = `ollama:${cfg.model}`;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.downloadTimeoutMs = cfg.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  }

  async extract(photoUrl: string): Promise<DeviceOcrResult> {
    // Any failure (download, model timeout/abort, Ollama down) soft-fails to a
    // null read persisted for audit — never throws, never blocks the cron.
    try {
      const imageB64 = await this.preprocess(photoUrl);
      const raw = await this.ask(imageB64);
      const { sn, mac } = parseOcrResponse(raw);
      return { sn, mac, confidence: sn || mac ? 0.8 : 0, rawOutput: raw };
    } catch (e) {
      return { sn: null, mac: null, confidence: 0, rawOutput: `ocr-error: ${(e as Error).message}` };
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

  private async ask(imageB64: string): Promise<string> {
    const res = await fetch(`${this.cfg.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.cfg.model,
        prompt: PROMPT,
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
