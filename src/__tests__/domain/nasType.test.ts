import { routesViaOrchestrator } from '@domain/entities/nas';

describe('routesViaOrchestrator', () => {
  it('returns true for radius_orchestrator (canonical value)', () => {
    expect(routesViaOrchestrator('radius_orchestrator')).toBe(true);
  });

  it('returns false for mikrotik_api', () => {
    expect(routesViaOrchestrator('mikrotik_api')).toBe(false);
  });

  it('returns false for cisco', () => {
    expect(routesViaOrchestrator('cisco')).toBe(false);
  });

  it('returns false for ubiquiti', () => {
    expect(routesViaOrchestrator('ubiquiti')).toBe(false);
  });

  it('returns false for cambium', () => {
    expect(routesViaOrchestrator('cambium')).toBe(false);
  });

  it('returns false for other', () => {
    expect(routesViaOrchestrator('other')).toBe(false);
  });
});
