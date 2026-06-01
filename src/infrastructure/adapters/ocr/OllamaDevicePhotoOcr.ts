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
}

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

  constructor(private readonly cfg: OllamaOcrConfig) {
    this.provider = `ollama:${cfg.model}`;
  }

  async extract(photoUrl: string): Promise<DeviceOcrResult> {
    let imageB64: string;
    try {
      imageB64 = await this.preprocess(photoUrl);
    } catch (e) {
      return { sn: null, mac: null, confidence: 0, rawOutput: `preprocess-error: ${(e as Error).message}` };
    }
    const raw = await this.ask(imageB64);
    const { sn, mac } = parseOcrResponse(raw);
    return { sn, mac, confidence: sn || mac ? 0.8 : 0, rawOutput: raw };
  }

  private async preprocess(url: string): Promise<string> {
    const res = await fetch(url);
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
    });
    const json = (await res.json()) as { response?: string };
    return json.response ?? '';
  }
}
