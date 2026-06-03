/**
 * Pure parser for the vision model's reply. The model is prompted to return
 * `{"mac":"...","sn":"..."}` but may wrap it in prose or ```json fences. Extracts
 * the first JSON object and normalizes — never throws, never invents data.
 */
export function parseOcrResponse(text: string): { sn: string | null; mac: string | null; deviceType: string | null } {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { sn: null, mac: null, deviceType: null };
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      sn: norm(obj.sn),
      mac: norm(obj.mac),
      deviceType: typeof obj.device_type === 'string' ? obj.device_type : null,
    };
  } catch {
    return { sn: null, mac: null, deviceType: null };
  }
}

function norm(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.toLowerCase() === 'null' || t.toLowerCase() === 'n/a') return null;
  return t;
}
