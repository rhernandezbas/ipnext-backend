import { randomUUID } from 'crypto';
import type {
  IClassDispatchAttempt,
  RecordDispatchAttemptInput,
} from '@domain/entities/iclass-dispatch-attempt';
import type { IClassDispatchAttemptRepository } from '@domain/ports/IClassDispatchAttemptRepository';

type StoredAttempt = IClassDispatchAttempt & { __seq: number };

/**
 * InMemoryIClassDispatchAttemptRepository — test seam for IClassDispatchAttemptRepository.
 *
 * `seed` is an extra helper for tests (lets a test set an explicit `createdAt`
 * for deterministic ordering assertions). NOT part of the port.
 */
export class InMemoryIClassDispatchAttemptRepository
  implements IClassDispatchAttemptRepository
{
  private readonly store: StoredAttempt[] = [];
  private seq = 0;

  async record(input: RecordDispatchAttemptInput): Promise<IClassDispatchAttempt> {
    return this.insert({
      id: randomUUID(),
      taskId: input.taskId,
      outcome: input.outcome,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      attemptedNodeCode: input.attemptedNodeCode ?? null,
      resolvedNodeCode: input.resolvedNodeCode ?? null,
      actorId: input.actorId ?? null,
      createdAt: new Date().toISOString(),
    });
  }

  /** Test helper — insert with explicit fields. NOT part of the port. */
  seed(partial: Partial<IClassDispatchAttempt> & { taskId: string; outcome: IClassDispatchAttempt['outcome'] }): IClassDispatchAttempt {
    return this.insert({
      id: partial.id ?? randomUUID(),
      taskId: partial.taskId,
      outcome: partial.outcome,
      errorCode: partial.errorCode ?? null,
      errorMessage: partial.errorMessage ?? null,
      attemptedNodeCode: partial.attemptedNodeCode ?? null,
      resolvedNodeCode: partial.resolvedNodeCode ?? null,
      actorId: partial.actorId ?? null,
      createdAt: partial.createdAt ?? new Date().toISOString(),
    });
  }

  async listByTask(taskId: string): Promise<IClassDispatchAttempt[]> {
    const filtered = this.store.filter(a => a.taskId === taskId);

    // createdAt ASC (oldest first); tie-break by insertion seq ASC (stable).
    filtered.sort((a, b) =>
      a.createdAt === b.createdAt ? a.__seq - b.__seq : a.createdAt < b.createdAt ? -1 : 1,
    );

    return filtered.map(a => this.clean(a));
  }

  private insert(attempt: IClassDispatchAttempt): IClassDispatchAttempt {
    const stored: StoredAttempt = { ...attempt, __seq: this.seq++ };
    this.store.push(stored);
    return this.clean(stored);
  }

  private clean(a: StoredAttempt): IClassDispatchAttempt {
    const { __seq: _seq, ...rest } = a;
    void _seq;
    return { ...rest };
  }
}
