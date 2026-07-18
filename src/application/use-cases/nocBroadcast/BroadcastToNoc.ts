import { NocBroadcastConfigRepository } from '@domain/ports/NocBroadcastConfigRepository';
import { NocBroadcastGateway } from '@domain/ports/NocBroadcastGateway';
import { NocBroadcastLinkBaseMissingError } from '@domain/errors/nocBroadcast';

/** What kind of thing is being broadcast — drives the message format. */
export type NocBroadcastKind = 'news' | 'network_task';

export interface BroadcastToNocInput {
  kind: NocBroadcastKind;
  /** Headline (news title / task title). */
  title: string;
  /** For network_task only: the node/area name. Omitted/blank → "[Red]" without a label. */
  contextLabel?: string;
  /** App-relative path of the deep link target, e.g. "/news/42" or "/scheduling/task/7". */
  relativePath: string;
}

export interface BroadcastToNocResult {
  sent: boolean;
  /** The absolute deep link that was included in the message. */
  link: string;
}

/**
 * N1 (noc-broadcast) — composes the WhatsApp text per `kind`, builds the deep link
 * from `appPublicUrl` + `relativePath`, and pushes it via the gateway. This is the
 * FOUNDATION use-case that N2 (news) and N3 (network tasks) call.
 *
 * NOT best-effort: it is user-triggered (a button), so gateway errors PROPAGATE
 * (the caller shows them). Reads `appPublicUrl` from the config to build the link;
 * the gateway itself re-reads the config to enforce `configured` at send time.
 *
 * Message formats (user decision):
 *   news         → "📢 {title}\n🔗 {link}"
 *   network_task → "📧 [Red · {contextLabel}] {title}\n🔗 {link}"
 *                  (no contextLabel → "📧 [Red] {title}\n🔗 {link}")
 */
export class BroadcastToNoc {
  constructor(
    private readonly config: NocBroadcastConfigRepository,
    private readonly gateway: NocBroadcastGateway,
  ) {}

  async execute(input: BroadcastToNocInput): Promise<BroadcastToNocResult> {
    const cfg = await this.config.get();
    if (cfg.appPublicUrl === '') {
      // A link without a host is useless in WhatsApp — fail loud instead of sending it.
      throw new NocBroadcastLinkBaseMissingError();
    }
    const link = buildDeepLink(cfg.appPublicUrl, input.relativePath);
    const text = composeText(input, link);
    await this.gateway.sendText(text);
    return { sent: true, link };
  }
}

/** Straight concatenation, collapsing a base trailing slash against the path's leading slash. */
function buildDeepLink(base: string, relativePath: string): string {
  return `${base.replace(/\/+$/, '')}${relativePath}`;
}

function composeText(input: BroadcastToNocInput, link: string): string {
  if (input.kind === 'news') {
    return `📢 ${input.title}\n🔗 ${link}`;
  }
  const hasLabel = input.contextLabel != null && input.contextLabel.trim() !== '';
  const label = hasLabel ? ` · ${input.contextLabel}` : '';
  return `📧 [Red${label}] ${input.title}\n🔗 ${link}`;
}
