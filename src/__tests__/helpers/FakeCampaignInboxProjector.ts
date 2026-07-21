import type {
  CampaignInboxProjector,
  ProjectSentMessageInput,
  ProjectChatwootTemplateSendInput,
} from '@domain/ports/CampaignInboxProjector';

/**
 * chatwoot-hub-sendpath (B4) — test double for `CampaignInboxProjector`. Molde
 * `FakeChatwootGateway`: arrays `*Calls` para asserts `toEqual`, sin lógica real
 * de proyección (esa vive en `PrismaCampaignInboxProjector`, ejercitada con
 * repos in-memory en `CampaignInboxProjector.test.ts` — seam completo). Útil en
 * `SendCampaign.test.ts` para verificar QUÉ método del port se invoca (dispatch
 * por flag) sin acoplarse a la lógica interna del projector real.
 */
export class FakeCampaignInboxProjector implements CampaignInboxProjector {
  public projectSentMessageCalls: ProjectSentMessageInput[] = [];
  public projectChatwootTemplateSendCalls: ProjectChatwootTemplateSendInput[] = [];
  public failProjectSentMessage = false;
  public failProjectChatwootTemplateSend = false;

  async projectSentMessage(input: ProjectSentMessageInput): Promise<void> {
    this.projectSentMessageCalls.push(input);
    if (this.failProjectSentMessage) throw new Error('fake: projectSentMessage failed');
  }

  async projectChatwootTemplateSend(input: ProjectChatwootTemplateSendInput): Promise<void> {
    this.projectChatwootTemplateSendCalls.push(input);
    if (this.failProjectChatwootTemplateSend) throw new Error('fake: projectChatwootTemplateSend failed');
  }
}
