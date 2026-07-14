import type { TemplateMessagingPort, TemplateDto, SendTemplateResult } from '@domain/ports/TemplateMessagingPort';
import { TemplateProviderUnavailableError, TemplateSendRejectedError } from '@domain/errors/messaging-bulk';

export interface TemplateMessagingCallRecord {
  to: string;
  contentSid: string;
  variables: Record<string, string>;
}

export interface InMemoryTemplateMessagingGatewayOptions {
  templates?: TemplateDto[];
  /** 1-based: el envío N-ésimo (y SOLO ese) lanza TemplateProviderUnavailableError (429). */
  failNthWith429?: number;
  /** ms sugerido por el proveedor en Retry-After — sale en el error del envío N-ésimo. */
  retryAfterMs?: number;
  /** Cualquier envío a este número lanza TemplateSendRejectedError (4xx per-mensaje). */
  rejectPhone?: string;
}

/**
 * InMemoryTemplateMessagingGateway — fake TemplateMessagingPort (messaging-bulk
 * F2, T3.2). Array de `TemplateDto` inyectable en el ctor + `sendTemplate` que
 * registra las llamadas (`calls`). Dos modos de falla configurables para
 * ejercitar el retry/backoff (Batch 4) y el manejo de rechazo per-destinatario
 * sin necesitar axios/nock real (regla TDD del repo — se inyecta el fake port).
 */
export class InMemoryTemplateMessagingGateway implements TemplateMessagingPort {
  public readonly calls: TemplateMessagingCallRecord[] = [];

  private readonly templates: TemplateDto[];
  private readonly failNthWith429?: number;
  private readonly retryAfterMs?: number;
  private readonly rejectPhone?: string;
  private sendCount = 0;

  constructor(opts: InMemoryTemplateMessagingGatewayOptions = {}) {
    this.templates = opts.templates ?? [];
    this.failNthWith429 = opts.failNthWith429;
    this.retryAfterMs = opts.retryAfterMs;
    this.rejectPhone = opts.rejectPhone;
  }

  async listTemplates(): Promise<TemplateDto[]> {
    return this.templates.map((t) => ({ ...t }));
  }

  async sendTemplate(to: string, contentSid: string, variables: Record<string, string>): Promise<SendTemplateResult> {
    this.sendCount += 1;
    this.calls.push({ to, contentSid, variables: { ...variables } });

    if (this.rejectPhone !== undefined && to === this.rejectPhone) {
      throw new TemplateSendRejectedError(`Provider rejected number ${to}`);
    }
    if (this.failNthWith429 !== undefined && this.sendCount === this.failNthWith429) {
      throw new TemplateProviderUnavailableError('Rate limited (fake 429)', this.retryAfterMs);
    }

    return { providerId: `SMfake${this.sendCount}`, status: 'queued' };
  }
}
