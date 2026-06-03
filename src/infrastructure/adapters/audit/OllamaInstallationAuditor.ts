import { Jimp, JimpMime } from 'jimp';
import { InstallationAuditor } from '@domain/ports/InstallationAuditor';
import { AuditContext, AuditResult } from '@domain/entities/installation-audit';
import { parseAuditResult } from './parseAuditResult';

export interface OllamaAuditConfig {
  baseUrl: string;
  model: string;
  /** Max wait for the model inference (ms). Default 180s. */
  timeoutMs?: number;
  /** Max wait per photo download (ms). Default 30s. */
  downloadTimeoutMs?: number;
  /** Cap the number of photos sent (cost/latency). Default 8. */
  maxPhotos?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PHOTOS = 8;

/**
 * Installation auditor via an Ollama vision model. Sends ALL closure photos in a
 * single multimodal request (Ollama supports `images[]`) plus the closure text +
 * the local task detail, and asks for a structured JSON array of findings. Never
 * throws — any failure (download, model down, invalid JSON) → `{ ok: false }`.
 */
export class OllamaInstallationAuditor implements InstallationAuditor {
  readonly provider: string;
  private readonly timeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly maxPhotos: number;

  constructor(private readonly cfg: OllamaAuditConfig) {
    this.provider = `ollama:${cfg.model}`;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.downloadTimeoutMs = cfg.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    this.maxPhotos = cfg.maxPhotos ?? DEFAULT_MAX_PHOTOS;
  }

  async audit(ctx: AuditContext): Promise<AuditResult> {
    try {
      const urls = ctx.photoUrls.slice(0, this.maxPhotos);
      const downloaded = await Promise.all(urls.map(u => this.fetchB64(u)));
      const images = downloaded.filter((x): x is string => !!x);
      const raw = await this.ask(this.renderPrompt(ctx), images);
      return parseAuditResult(raw);
    } catch {
      return { ok: false, findings: [] };
    }
  }

  private renderPrompt(ctx: AuditContext): string {
    const checklist = ctx.checklistText.map(q => `- ${q.question}: ${q.answer}`).join('\n') || '(sin respuestas de texto)';
    const materials = ctx.materials.map(m => `- ${m.description ?? 'material'} x${m.qty}`).join('\n') || '(sin materiales)';
    const comments = ctx.taskComments.join('\n') || '(sin comentarios)';
    return [
      'Sos un auditor de calidad de instalaciones de fibra/ISP. Te paso el contexto de cierre de una orden de servicio',
      'y TODAS las fotos del técnico. Evaluá la CALIDAD de la instalación comparando el PROBLEMA REPORTADO con lo HECHO.',
      'Detectá problemas: señal fuera de rango, conexiones mal hechas, fotos feas/insuficientes/borrosas, instalación deficiente, etc.',
      '',
      `OS: ${ctx.osCodigo} | Técnico: ${ctx.technicianName ?? '?'} | Motivo de cierre: ${ctx.resultCodeName ?? '?'}`,
      `Tarea: ${ctx.taskTitle}`,
      `Problema reportado: ${ctx.taskDescription ?? '(sin descripción)'}`,
      'Comentarios de la tarea:',
      comments,
      'Checklist:',
      checklist,
      `Observaciones del técnico: ${ctx.technicianNote ?? '(ninguna)'}`,
      'Materiales:',
      materials,
      '',
      'Respondé EXCLUSIVAMENTE un array JSON. Cada item:',
      '{"severity":"ok|warning|critical","category":"señal|conexión|fotos|instalación|otros","text":"..."}.',
      'severity y category DEBEN ser exactamente uno de esos valores. Si no hay problemas, devolvé []. No agregues texto fuera del JSON.',
    ].join('\n');
  }

  private async fetchB64(url: string): Promise<string | null> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(this.downloadTimeoutMs) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const image = await Jimp.read(buf);
      if (image.width > 1280) image.resize({ w: 1280 }); // bound payload
      const out = await image.getBuffer(JimpMime.jpeg);
      return out.toString('base64');
    } catch {
      return null;
    }
  }

  private async ask(prompt: string, images: string[]): Promise<string> {
    const res = await fetch(`${this.cfg.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.cfg.model, prompt, images, stream: false, format: 'json', options: { temperature: 0 } }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = (await res.json()) as { response?: string };
    return json.response ?? '';
  }
}
