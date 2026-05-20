import { randomUUID } from 'crypto';
import { Workflow, Stage } from '@domain/entities/workflow';
import { WorkflowRepository } from '@domain/ports/WorkflowRepository';

export class InMemoryWorkflowRepository implements WorkflowRepository {
  private workflows: Workflow[] = [];

  async list(): Promise<Workflow[]> {
    return this.workflows.map(w => ({ ...w, stages: [...w.stages] }));
  }

  async getById(id: string): Promise<Workflow | null> {
    const wf = this.workflows.find(w => w.id === id);
    return wf ? { ...wf, stages: [...wf.stages] } : null;
  }

  async getByName(name: string): Promise<Workflow | null> {
    const wf = this.workflows.find(w => w.name.toLowerCase() === name.toLowerCase());
    return wf ? { ...wf, stages: [...wf.stages] } : null;
  }

  async create(data: {
    name: string;
    description: string | null;
    stages: Array<Pick<Stage, 'name' | 'category' | 'order'>>;
  }): Promise<Workflow> {
    const now = new Date().toISOString();
    const wfId = randomUUID();
    const stages: Stage[] = (data.stages ?? []).map(s => ({
      id: randomUUID(),
      workflowId: wfId,
      name: s.name,
      category: s.category,
      order: s.order,
    }));
    const wf: Workflow = {
      id: wfId,
      name: data.name,
      description: data.description,
      stages: stages.sort((a, b) => a.order - b.order),
      createdAt: now,
      updatedAt: now,
    };
    this.workflows.push(wf);
    return { ...wf, stages: [...wf.stages] };
  }

  async update(id: string, data: Partial<Pick<Workflow, 'name' | 'description'>>): Promise<Workflow | null> {
    const index = this.workflows.findIndex(w => w.id === id);
    if (index === -1) return null;
    this.workflows[index] = {
      ...this.workflows[index],
      ...data,
      updatedAt: new Date().toISOString(),
    };
    const wf = this.workflows[index];
    return { ...wf, stages: [...wf.stages] };
  }

  async delete(id: string): Promise<boolean> {
    const index = this.workflows.findIndex(w => w.id === id);
    if (index === -1) return false;
    this.workflows.splice(index, 1);
    return true;
  }
}
