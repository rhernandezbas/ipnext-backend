import { ProjectRepository } from '@domain/ports/ProjectRepository';

export interface DispatchPreviewRow {
  projectId: string;
  projectTitle: string;
  /**
   * IClass SO type mapped to this project. null when no mapping exists.
   * Note: code = IClass typeSOSummary code, description = human label.
   */
  soType: { code: string; description: string } | null;
  /**
   * How the IClass node (microárea) is resolved at dispatch time.
   * Always 'by-customer-city' — the adapter calls iclass.listNodes() and
   * matches by normalized city name at runtime (not per-project config).
   */
  nodeResolution: 'by-customer-city';
  /** Source of customerCode field sent to IClass. */
  customerCodeSource: 'contractCode-or-customerCode';
  /** Source of phone field sent to IClass. */
  phoneSource: 'customer-phone';
  /** Source of soCode field sent to IClass. */
  soCodeSource: 'task-sequence-number';
  /**
   * The initial OS status after creation. IClass assigns it — Prominense
   * does NOT send a status in createServiceOrder (verified in dispatchTaskToIClass).
   */
  initialStatus: 'assigned-by-iclass';
  /**
   * Hardcoded values used for RED/FIBRA network tasks where there is no real customer.
   * Informational only — not applied to all projects.
   */
  hardcoded: {
    networkPhone: '0000000000';
    networkCustomerCode: 'NETWORK';
  };
}

export interface GetIClassDispatchPreviewResult {
  items: DispatchPreviewRow[];
}

/**
 * GetIClassDispatchPreview — Ola C read-only endpoint (AD-3).
 *
 * Reads all projects and describes, per project, what dispatchTaskToIClass
 * would send to IClass for a customer task. No simulation — derives the
 * RULES from existing config without touching the real dispatch.
 */
export class GetIClassDispatchPreview {
  constructor(private readonly projectRepo: ProjectRepository) {}

  async execute(): Promise<GetIClassDispatchPreviewResult> {
    const projects = await this.projectRepo.list();

    const items: DispatchPreviewRow[] = projects.map(p => ({
      projectId: p.id,
      projectTitle: p.title,
      soType: p.iclassSoType
        ? { code: p.iclassSoType.code, description: p.iclassSoType.description }
        : null,
      nodeResolution: 'by-customer-city',
      customerCodeSource: 'contractCode-or-customerCode',
      phoneSource: 'customer-phone',
      soCodeSource: 'task-sequence-number',
      initialStatus: 'assigned-by-iclass',
      hardcoded: {
        networkPhone: '0000000000',
        networkCustomerCode: 'NETWORK',
      },
    }));

    return { items };
  }
}
