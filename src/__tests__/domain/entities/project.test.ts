/**
 * Phase 2.1 — Compilation-only test asserting the new Project shape.
 * Acts as a red test until the entity is updated (Phase 2.2).
 */
import { Project } from '../../../domain/entities/project';

// This test verifies the shape compiles. If any field is missing the tsc step will fail.
describe('Project entity — enriched shape', () => {
  it('has the new FK and metadata fields', () => {
    const p: Project = {
      id: 'p-1',
      title: 'Test',
      description: null,
      typeId: null,
      categoryId: null,
      workflowId: null,
      projectLeadId: null,
      visible: true,
      partners: [],
      taskCounts: { nuevo: 0, enProgreso: 0, hecho: 0, total: 0 },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(p.typeId).toBeNull();
    expect(p.categoryId).toBeNull();
    expect(p.workflowId).toBeNull();
    expect(p.projectLeadId).toBeNull();
    expect(p.visible).toBe(true);
    expect(p.partners).toEqual([]);
  });

  it('partners can hold id/name objects', () => {
    const p: Project = {
      id: 'p-2',
      title: 'With Partners',
      description: 'desc',
      typeId: 'type-1',
      categoryId: 'cat-1',
      workflowId: 'wf-1',
      projectLeadId: 'admin-1',
      visible: false,
      partners: [{ id: 'partner-1', name: 'IPNEXT BA' }],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(p.partners[0].id).toBe('partner-1');
    expect(p.partners[0].name).toBe('IPNEXT BA');
  });
});
