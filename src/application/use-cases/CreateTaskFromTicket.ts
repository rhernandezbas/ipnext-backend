import { SchedulingRepository, CreateTaskInput } from '@domain/ports/SchedulingRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { CreateTask } from './CreateTask';

/**
 * Input for CreateTaskFromTicket.
 *
 * AD-2: contractId is REQUIRED — a ticket has no contractId, so the FE must
 *       supply it from the client's contract picker.
 * AD-7: ticketId comes from the route path (NOT the body) and is NOT body-overridable.
 *       The route layer passes it here directly.
 */
export interface CreateTaskFromTicketInput extends Omit<CreateTaskInput, 'ticketId'> {
  /** The ticket's id — injected by the route from the path param :id. NOT body-overridable. */
  ticketId: string;
  /**
   * The ticket's subject — used to prefill the task title/description when the FE
   * omits them. The route resolves this from the ticket lookup before calling here.
   */
  ticketSubject: string;
}

/**
 * AD-1: Delegates to CreateTask so FK validation, watchers, etc. all remain in one place.
 */
export class CreateTaskFromTicket {
  constructor(
    private readonly createTask: CreateTask,
    private readonly _repo: SchedulingRepository,
  ) {}

  async execute(input: CreateTaskFromTicketInput): Promise<ScheduledTask> {
    const taskInput: CreateTaskInput = {
      ...input,
      // ticketId flows through to CreateTask which validates it against ticketLookup
      ticketId: input.ticketId,
    };

    return this.createTask.execute(taskInput);
  }
}
