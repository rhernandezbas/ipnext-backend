import { routesViaOrchestrator } from '@domain/entities/nas';

describe('routesViaOrchestrator', () => {
  it('returns true for radius_orchestrator (canonical new value)', () => {
    expect(routesViaOrchestrator('radius_orchestrator')).toBe(true);
  });

  it('returns true for mikrotik_radius (legacy value — expand-contract)', () => {
    expect(routesViaOrchestrator('mikrotik_radius')).toBe(true);
  });

  it('returns false for mikrotik_api', () => {
    expect(routesViaOrchestrator('mikrotik_api')).toBe(false);
  });

  it('returns false for huawei_radius', () => {
    expect(routesViaOrchestrator('huawei_radius')).toBe(false);
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
