import { DeviceOcrResult } from '@domain/ports/DevicePhotoOcr';
import { parseOcrResponse } from './parseOcrResponse';
import { normalizeMac, normalizeSn } from './normalizeDeviceFields';

/**
 * Turns the model's raw reply into a validated DeviceOcrResult: extract the JSON,
 * then format-validate SN/MAC (malformed → null). Confidence is derived from the
 * VALIDATED fields, so a plausible-but-malformed read no longer scores 0.8 — it
 * drops to 0 and stays `pending` for manual entry. Pure; never throws.
 */
export function finalizeOcrResult(rawOutput: string): DeviceOcrResult {
  const parsed = parseOcrResponse(rawOutput);
  const sn = normalizeSn(parsed.sn);
  const mac = normalizeMac(parsed.mac);
  return { sn, mac, confidence: sn || mac ? 0.8 : 0, rawOutput, deviceType: parsed.deviceType ?? undefined };
}
