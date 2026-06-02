/**
 * IClassDispatchAttemptRepository — domain port.
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 */
import type {
  IClassDispatchAttempt,
  RecordDispatchAttemptInput,
} from '@domain/entities/iclass-dispatch-attempt';

export interface IClassDispatchAttemptRepository {
  /** Registra un intento. Best-effort: el caller envuelve en try/catch (AD-6). */
  record(input: RecordDispatchAttemptInput): Promise<IClassDispatchAttempt>;
  /** Historial de intentos de una tarea, ordenado por createdAt ASC (mas antiguo primero). */
  listByTask(taskId: string): Promise<IClassDispatchAttempt[]>;
}
