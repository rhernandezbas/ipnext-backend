import { randomUUID } from 'crypto';
import type {
  AssistantEvalRepository,
  AssistantEvalRun,
  RecordAssistantEvalRunInput,
} from '@domain/ports/AssistantEvalRepository';
import type { AssistantEvalGate } from '@domain/ports/AssistantEvalGate';

/**
 * ai-assistant-multiagent (EVAL-1/EVAL-2) — corridas de evaluación en memoria.
 *
 * Implementa TAMBIÉN `AssistantEvalGate` (igual que el adapter Prisma): así los tests de ruta
 * pueden usar una sola instancia para registrar Y para el candado, y el seam queda probado de
 * punta a punta — registrar destraba de verdad `resolve_conversation`, no sólo devuelve 201.
 */
export class InMemoryAssistantEvalRepository implements AssistantEvalRepository, AssistantEvalGate {
  private readonly runs: AssistantEvalRun[] = [];

  async record(input: RecordAssistantEvalRunInput): Promise<AssistantEvalRun> {
    const run: AssistantEvalRun = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input,
    };
    // Más nuevas primero — espeja el `orderBy: { createdAt: 'desc' }` del adapter Prisma.
    this.runs.unshift(run);
    return { ...run };
  }

  async list(limit: number): Promise<AssistantEvalRun[]> {
    return this.runs.slice(0, limit).map((run) => ({ ...run }));
  }

  async hasAnyRun(): Promise<boolean> {
    return this.runs.length > 0;
  }

  /** EVAL-2 — la pregunta que hace el gate al habilitar una acción de riesgo alto. */
  async hasRecordedRun(): Promise<boolean> {
    return this.hasAnyRun();
  }
}
