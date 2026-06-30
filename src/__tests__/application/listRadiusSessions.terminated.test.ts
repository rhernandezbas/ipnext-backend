/**
 * listRadiusSessions.terminated.test.ts
 *
 * Bug: ListRadiusSessions unía sesiones RADIUS con PppoeService por username sin filtrar
 * por status. Un PPPoE terminated con contractId no-null (estado que dejaba TerminatePppoeService
 * antes del fix) hacía que la sesión devolviera contractId/clientId/customerName reales →
 * el FE no mostraba el ⚠ ("PPPoE sin contrato asociado") aunque el contrato no tuviera servicio.
 *
 * Fix esperado: si el PppoeService matcheado tiene status='terminated', se tratan los 3
 * campos de contrato como null → el FE muestra el ⚠ correctamente.
 */
import { ListRadiusSessions } from '@application/use-cases/ListRadiusSessions';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { RadiusSessionRepository } from '@domain/ports/RadiusSessionRepository';
import { RadiusSession } from '@domain/entities/radiusSessions';

class StubRadiusSessionRepository implements RadiusSessionRepository {
  constructor(private readonly sessions: RadiusSession[]) {}
  async listSessions(): Promise<RadiusSession[]> { return [...this.sessions]; }
  async disconnectSession(_id: string): Promise<{ success: boolean }> { return { success: true }; }
}

const BASE_SESSION: Omit<RadiusSession, 'username' | 'id' | 'sessionId'> = {
  clientName:    'Cliente Test',
  nasId:         'nas-1',
  nasName:       'NAS Central',
  ipAddress:     '100.64.9.245',
  macAddress:    '6C:68:A4:01:02:03',
  startedAt:     '2026-06-30T10:00:00Z',
  duration:      3600,
  downloadBytes: 1000000,
  uploadBytes:   500000,
  downloadMbps:  10,
  uploadMbps:    2,
  status:        'active',
  contractId:    null,
  clientId:      null,
  customerName:  null,
};

describe('ListRadiusSessions — PPPoE terminated se trata como sin contrato (muestra ⚠ en FE)', () => {
  it('devuelve contractId/clientId/customerName null cuando el PPPoE matcheado está terminated', async () => {
    const pppoeRepo = new InMemoryPppoeServiceRepository();
    pppoeRepo.setContractClient('contract-abc', 'client-123', 'MOYANO CINTIA');

    // PPPoE terminated con contractId (estado pre-fix de TerminatePppoeService)
    await pppoeRepo.upsertByUsername({
      username:      'CintiaMoyanoMercFibra',
      password:      'irrelevant',
      profile:       'IP-Fibra-100',
      remoteAddress: null,
      status:        'terminated',
      nasId:         'nas-1',
      contractId:    'contract-abc',
    });

    const sessionRepo = new StubRadiusSessionRepository([
      { ...BASE_SESSION, id: 'sess-1', sessionId: 'ACCT0001', username: 'CintiaMoyanoMercFibra' },
    ]);

    const useCase = new ListRadiusSessions(sessionRepo, pppoeRepo);
    const sessions = await useCase.execute();

    expect(sessions).toHaveLength(1);
    // El PPPoE está terminated → el FE debe mostrar ⚠ → los 3 campos deben ser null
    expect(sessions[0]!.contractId).toBeNull();
    expect(sessions[0]!.clientId).toBeNull();
    expect(sessions[0]!.customerName).toBeNull();
  });

  it('devuelve los datos del contrato cuando el PPPoE está enabled (sesión legítima)', async () => {
    const pppoeRepo = new InMemoryPppoeServiceRepository();
    pppoeRepo.setContractClient('contract-xyz', 'client-456', 'GARCIA JUAN');

    await pppoeRepo.upsertByUsername({
      username:      'JuanGarciaFibra',
      password:      'pass',
      profile:       'IP-Fibra-50',
      remoteAddress: '100.64.9.100',
      status:        'enabled',
      nasId:         'nas-1',
      contractId:    'contract-xyz',
    });

    const sessionRepo = new StubRadiusSessionRepository([
      { ...BASE_SESSION, id: 'sess-2', sessionId: 'ACCT0002', username: 'JuanGarciaFibra' },
    ]);

    const useCase = new ListRadiusSessions(sessionRepo, pppoeRepo);
    const sessions = await useCase.execute();

    expect(sessions).toHaveLength(1);
    // PPPoE enabled con contrato → datos del contrato visibles, sin ⚠
    expect(sessions[0]!.contractId).toBe('contract-xyz');
    expect(sessions[0]!.clientId).toBe('client-456');
    expect(sessions[0]!.customerName).toBe('GARCIA JUAN');
  });

  it('devuelve null para sesiones sin PPPoE en Prominense (usuario desconocido)', async () => {
    const pppoeRepo = new InMemoryPppoeServiceRepository();

    const sessionRepo = new StubRadiusSessionRepository([
      { ...BASE_SESSION, id: 'sess-3', sessionId: 'ACCT0003', username: 'usuarioDesconocido' },
    ]);

    const useCase = new ListRadiusSessions(sessionRepo, pppoeRepo);
    const sessions = await useCase.execute();

    expect(sessions[0]!.contractId).toBeNull();
    expect(sessions[0]!.clientId).toBeNull();
    expect(sessions[0]!.customerName).toBeNull();
  });
});
