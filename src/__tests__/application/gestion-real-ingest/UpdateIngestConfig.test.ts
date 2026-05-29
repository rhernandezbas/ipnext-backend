import { UpdateIngestConfig } from '@application/use-cases/UpdateIngestConfig';
import { InMemoryGestionRealIngestConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGestionRealIngestConfigRepository';
import { InMemoryProjectRepository } from '@infrastructure/adapters/in-memory/InMemoryProjectRepository';
import { ProjectNotFoundError } from '@domain/errors/projects';

async function seedProject(projects: InMemoryProjectRepository, title: string): Promise<string> {
  const p = await projects.create({ title });
  return p.id;
}

describe('UpdateIngestConfig', () => {
  function build() {
    const config = new InMemoryGestionRealIngestConfigRepository();
    const projects = new InMemoryProjectRepository();
    const useCase = new UpdateIngestConfig(config, projects);
    return { config, projects, useCase };
  }

  it('updates enabled / interval / windowMonths (REQ-PUTCFG-1)', async () => {
    const { useCase } = build();

    const dto = await useCase.execute({ enabled: true, intervalMs: 60000, windowMonths: 6 });

    expect(dto.enabled).toBe(true);
    expect(dto.intervalMs).toBe(60000);
    expect(dto.windowMonths).toBe(6);
  });

  it('updates the target project FK when it exists (REQ-PUTCFG-1)', async () => {
    const { useCase, projects } = build();
    const fiberId = await seedProject(projects, 'Fiber');

    const dto = await useCase.execute({ fiberProjectId: fiberId });

    expect(dto.fiberProjectId).toBe(fiberId);
  });

  it('rejects a non-existent project FK with PROJECT_NOT_FOUND and does not persist (REQ-PUTCFG-2)', async () => {
    const { useCase, config } = build();

    await expect(useCase.execute({ wirelessProjectId: 'ghost' })).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );

    const after = await config.get();
    expect(after.wirelessProjectId).toBeNull();
  });

  it('clears a mapping with null without performing a project lookup', async () => {
    const { useCase, projects } = build();
    const wifiId = await seedProject(projects, 'Wifi');
    await useCase.execute({ wirelessProjectId: wifiId });

    // Spy: null must NOT trigger projects.get
    const getSpy = jest.spyOn(projects, 'get');
    const dto = await useCase.execute({ wirelessProjectId: null });

    expect(dto.wirelessProjectId).toBeNull();
    expect(getSpy).not.toHaveBeenCalled();
  });
});
