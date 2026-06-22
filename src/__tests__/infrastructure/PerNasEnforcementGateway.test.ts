import { PerNasEnforcementGateway } from '@infrastructure/adapters/enforcement/PerNasEnforcementGateway';
import { EnforcementGateway } from '@domain/ports/EnforcementGateway';
import { PppoeService, EnforcementAction } from '@domain/entities/pppoeService';
import { NasServer, NasType } from '@domain/entities/nas';

class RecordingGateway implements EnforcementGateway {
  public readonly calls: Array<{ username: string; nasType: NasType; action: EnforcementAction }> = [];
  async apply(pppoe: PppoeService, nas: NasServer, action: EnforcementAction): Promise<void> {
    this.calls.push({ username: pppoe.username, nasType: nas.type, action });
  }
}

function pppoe(): PppoeService {
  return {
    id: 'p1', username: 'cli', password: 'pw', profile: 'IP-Air-30-10',
    remoteAddress: null, status: 'enabled', nasId: 'n', contractId: null,
    enforcedState: 'active', callerId: null, createdAt: '2026-01-01',
  };
}

function nasOfType(type: NasType): NasServer {
  return {
    id: 'n', name: 'r', type, ipAddress: '10.0.0.1',
    radiusSecret: '', nasIpAddress: '', apiPort: 8728, apiLogin: null, apiPassword: null,
    status: 'active', lastSeen: null, clientCount: 0, description: '',
  };
}

describe('PerNasEnforcementGateway (Inc2 — routeo por nas.type)', () => {
  function setup() {
    const mkDirect = new RecordingGateway();
    const radius = new RecordingGateway();
    const gw = new PerNasEnforcementGateway(mkDirect, radius);
    return { mkDirect, radius, gw };
  }

  it("nas.type='mikrotik_radius' → corta por el adapter RADIUS", async () => {
    const { mkDirect, radius, gw } = setup();
    await gw.apply(pppoe(), nasOfType('mikrotik_radius'), 'reduce');
    expect(radius.calls).toHaveLength(1);
    expect(mkDirect.calls).toHaveLength(0);
  });

  it("nas.type='mikrotik_api' → corta por el adapter MK-directo", async () => {
    const { mkDirect, radius, gw } = setup();
    await gw.apply(pppoe(), nasOfType('mikrotik_api'), 'block');
    expect(mkDirect.calls).toHaveLength(1);
    expect(radius.calls).toHaveLength(0);
  });

  it('cualquier otro type cae al DEFAULT SEGURO (MK-directo), nunca a RADIUS', async () => {
    for (const t of ['other', 'ubiquiti', 'cisco', 'cambium'] as NasType[]) {
      const { mkDirect, radius, gw } = setup();
      await gw.apply(pppoe(), nasOfType(t), 'restore');
      expect(mkDirect.calls).toHaveLength(1);
      expect(radius.calls).toHaveLength(0);
    }
  });

  it('propaga la acción y el pppoe tal cual al adapter elegido', async () => {
    const { radius, gw } = setup();
    await gw.apply(pppoe(), nasOfType('mikrotik_radius'), 'block');
    expect(radius.calls[0]).toEqual({ username: 'cli', nasType: 'mikrotik_radius', action: 'block' });
  });
});
