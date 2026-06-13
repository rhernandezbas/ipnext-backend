import { RecaptureRepository } from '@domain/ports/RecaptureRepository';
import { RecaptureContactChannel, RecaptureContactOutcome, RecaptureLeadStatus } from '@domain/entities/recaptureLead';
import { RecaptureLeadNotFoundError } from '@domain/errors/recapture';
import { RecaptureContactDto, toRecaptureContactDto } from '@application/dto/recapture/recapture.dto';

export interface AddRecaptureContactInput {
  leadId: string;
  actorId: string;
  channel: RecaptureContactChannel;
  outcome: RecaptureContactOutcome;
  proposal?: string | null;
  note?: string | null;
  nextStepAt?: string | null;
  /** If set, also advances the lead's status */
  advanceStatus?: RecaptureLeadStatus;
}

export class AddRecaptureContact {
  constructor(private readonly repo: RecaptureRepository) {}

  async execute(input: AddRecaptureContactInput): Promise<RecaptureContactDto> {
    // Validate the lead exists before appending a contact
    const lead = await this.repo.getById(input.leadId);
    if (!lead) throw new RecaptureLeadNotFoundError(input.leadId);

    const contact = await this.repo.addContact({
      leadId: input.leadId,
      actorId: input.actorId,
      channel: input.channel,
      outcome: input.outcome,
      proposal: input.proposal,
      note: input.note,
      nextStepAt: input.nextStepAt,
      advanceStatus: input.advanceStatus,
    });

    return toRecaptureContactDto(contact);
  }
}
