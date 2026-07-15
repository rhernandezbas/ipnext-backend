import type {
  TemplateMessagingPort,
  TemplateAdminPort,
  TemplateDto,
  SendTemplateResult,
  CreateTemplateInput,
} from '@domain/ports/TemplateMessagingPort';
import {
  TemplateProviderUnavailableError,
  TemplateSendRejectedError,
  TemplateNotFoundError,
} from '@domain/errors/messaging-bulk';

export interface TemplateMessagingCallRecord {
  to: string;
  contentSid: string;
  variables: Record<string, string>;
}

/** Change 3 (templates CRUD) — registros de las llamadas admin, para asserts. */
export interface TemplateCreateCallRecord {
  friendlyName: string;
  language: string;
  variables: Record<string, string>;
  body: string;
}
export interface TemplateDeleteCallRecord {
  contentSid: string;
  deleteInWaba: boolean;
}
export interface TemplateSubmitCallRecord {
  contentSid: string;
  name: string;
  category: string;
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
 * InMemoryTemplateMessagingGateway — fake de AMBOS ports de templates
 * (`TemplateMessagingPort` del send-path F2 + `TemplateAdminPort` del CRUD del
 * Change 3). Sostiene un store por `contentSid` (seedeable desde el ctor) para
 * que create→get→delete/submit sean coherentes entre sí y con `listTemplates`.
 * NO se mockea axios — se inyecta este fake (regla TDD del repo).
 */
export class InMemoryTemplateMessagingGateway implements TemplateMessagingPort, TemplateAdminPort {
  public readonly calls: TemplateMessagingCallRecord[] = [];
  public readonly createCalls: TemplateCreateCallRecord[] = [];
  public readonly deleteCalls: TemplateDeleteCallRecord[] = [];
  public readonly submitCalls: TemplateSubmitCallRecord[] = [];

  private readonly store = new Map<string, TemplateDto>();
  private readonly failNthWith429?: number;
  private readonly retryAfterMs?: number;
  private readonly rejectPhone?: string;
  private sendCount = 0;
  private createCount = 0;

  constructor(opts: InMemoryTemplateMessagingGatewayOptions = {}) {
    for (const t of opts.templates ?? []) {
      this.store.set(t.contentSid, { ...t });
    }
    this.failNthWith429 = opts.failNthWith429;
    this.retryAfterMs = opts.retryAfterMs;
    this.rejectPhone = opts.rejectPhone;
  }

  // ─── TemplateMessagingPort (send-path F2) ─────────────────────────────────

  async listTemplates(): Promise<TemplateDto[]> {
    return Array.from(this.store.values()).map((t) => ({ ...t }));
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

  // ─── TemplateAdminPort (CRUD, Change 3) ───────────────────────────────────

  async createTemplate(input: CreateTemplateInput): Promise<TemplateDto> {
    this.createCalls.push({
      friendlyName: input.friendlyName,
      language: input.language,
      variables: { ...input.variables },
      body: input.body,
    });
    this.createCount += 1;
    const dto: TemplateDto = {
      contentSid: `HXfake${this.createCount}`,
      friendlyName: input.friendlyName,
      language: input.language,
      variables: { ...input.variables },
      approvalStatus: 'unsubmitted',
      body: input.body,
    };
    this.store.set(dto.contentSid, dto);
    return { ...dto };
  }

  async getTemplate(contentSid: string): Promise<TemplateDto> {
    const t = this.store.get(contentSid);
    if (!t) throw new TemplateNotFoundError(`Template ${contentSid} not found`);
    return { ...t };
  }

  async deleteTemplate(contentSid: string, deleteInWaba = false): Promise<void> {
    if (!this.store.has(contentSid)) {
      throw new TemplateNotFoundError(`Template ${contentSid} not found`);
    }
    this.deleteCalls.push({ contentSid, deleteInWaba });
    this.store.delete(contentSid);
  }

  async submitForApproval(contentSid: string, name: string, category: string): Promise<void> {
    const t = this.store.get(contentSid);
    if (!t) throw new TemplateNotFoundError(`Template ${contentSid} not found`);
    this.submitCalls.push({ contentSid, name, category });
    t.approvalStatus = 'pending';
    t.category = category;
  }
}
