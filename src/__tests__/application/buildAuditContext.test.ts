import { buildAuditContext } from '@application/services/buildAuditContext';
import {
  HISTORY_MAX_ENTRIES,
  HISTORY_COMMENTARY_MAX_CHARS,
  COMMENTARY_LOG_MAX_CHARS,
  INTERNAL_NOTE_MAX_CHARS,
  EQUIPMENT_EVENTS_MAX,
} from '@application/services/buildAuditContext';
import { ClosedServiceOrder, SoStatusHistoryEntry, SoEquipmentEvent } from '@domain/entities/iclass-closed-order';
import { ScheduledTask } from '@domain/entities/scheduling';
import { TaskComment } from '@domain/entities/taskComment';

// ── Fixtures ────────────────────────────────────────────────────────────────

function baseOrder(over: Partial<ClosedServiceOrder> = {}): ClosedServiceOrder {
  return {
    iclassId: '1', iclassCodigo: '4691',
    clusterName: 'CLU', thirdPartyCode: null, nodeCode: null,
    soTypeId: null, soTypeDescription: null,
    customerCode: null, customerName: null,
    addressCode: null, addressLine: null, addressCity: null,
    addressLat: null, addressLng: null,
    statusCode: '7', statusDescription: 'Concluida',
    requestedAt: null, scheduledFor: null, availableAt: null,
    serviceStartedAt: null, serviceEndedAt: null,
    resultCodeName: 'Instalacion Completa Fibra',
    closedByLogin: null, closedByName: null,
    closeLatitude: null, closeLongitude: null, closeGpsAt: null,
    billingAmount: null,
    technicianNote: null, internalNote: null, commentaryLog: null,
    teamLogin: null, teamTechnicianName: 'Rodrigo', teamPhone: null, teamEmail: null,
    iclassCreatedAt: null, iclassUpdatedAt: null,
    rawDetail: {},
    closedAt: null, firstClosedAt: null, approvedAt: null, resultCodeType: null,
    history: [], checklists: [], materials: [], equipmentEvents: [],
    ...over,
  };
}

function baseTask(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return { id: 't1', title: 'Instalación', description: null, ...over } as ScheduledTask;
}

function historyEntry(commentary: string | null, status = 'Concluida'): SoStatusHistoryEntry {
  return {
    iclassOsStatusId: Math.random().toString(),
    occurredAt: null, statusCode: '7',
    statusDescription: status,
    durationMinutes: null, teamLogin: null,
    commentary,
  };
}

function equipmentEvent(over: Partial<SoEquipmentEvent> = {}): SoEquipmentEvent {
  return { occurredAt: null, type: 'install', serialNumber: 'SN1', mac: 'AA:BB', patrimonialNo: null, modelDescription: 'ONT', ...over };
}

const NO_COMMENTS: TaskComment[] = [];

// ── Task 1.1 — AuditContext shape: new fields with empty defaults ─────────────
describe('buildAuditContext — new fields (F6-R7)', () => {
  it('includes historyCommentary, commentaryLog, internalNote, equipmentEvents with empty defaults', () => {
    const ctx = buildAuditContext(baseOrder(), baseTask(), NO_COMMENTS);

    expect(ctx).toHaveProperty('historyCommentary');
    expect(ctx).toHaveProperty('commentaryLog');
    expect(ctx).toHaveProperty('internalNote');
    expect(ctx).toHaveProperty('equipmentEvents');

    expect(ctx.historyCommentary).toEqual([]);
    expect(ctx.commentaryLog).toBe('');
    expect(ctx.internalNote).toBe('');
    expect(ctx.equipmentEvents).toEqual([]);
  });

  // ── Task 2.2 — full history trimmed to HISTORY_MAX_ENTRIES (last 10) ────────
  it('trims history to last HISTORY_MAX_ENTRIES when more than max commentary entries exist', () => {
    // 12 entries with commentary → keep last 10
    const history = Array.from({ length: 12 }, (_, i) =>
      historyEntry(`commentary-${i}`, `Status${i}`),
    );
    const ctx = buildAuditContext(baseOrder({ history }), baseTask(), NO_COMMENTS);

    expect(ctx.historyCommentary).toHaveLength(HISTORY_MAX_ENTRIES);
    // last 10 are indices 2..11 — check last entry is the last one
    expect(ctx.historyCommentary[9].commentary).toBe('commentary-11');
    ctx.historyCommentary.forEach(e => {
      expect(e.commentary.length).toBeLessThanOrEqual(HISTORY_COMMENTARY_MAX_CHARS);
    });
  });

  // ── Task 2.4 — history entries without commentary excluded ─────────────────
  it('excludes history entries with empty or null commentary', () => {
    const history = [
      historyEntry('real comment 1'),
      historyEntry(null),
      historyEntry(''),
      historyEntry('real comment 2'),
      historyEntry(null),
      historyEntry('real comment 3'),
      historyEntry(''),
      historyEntry('real comment 4'),
    ];
    const ctx = buildAuditContext(baseOrder({ history }), baseTask(), NO_COMMENTS);
    expect(ctx.historyCommentary).toHaveLength(4);
  });

  // ── Task 2.5 — commentaryLog truncated ────────────────────────────────────
  it('truncates commentaryLog to COMMENTARY_LOG_MAX_CHARS', () => {
    const longLog = 'x'.repeat(800);
    const ctx = buildAuditContext(baseOrder({ commentaryLog: longLog }), baseTask(), NO_COMMENTS);
    expect(ctx.commentaryLog).toHaveLength(COMMENTARY_LOG_MAX_CHARS);
  });

  // ── Task 2.6 — internalNote truncated ────────────────────────────────────
  it('truncates internalNote to INTERNAL_NOTE_MAX_CHARS', () => {
    const longNote = 'n'.repeat(600);
    const ctx = buildAuditContext(baseOrder({ internalNote: longNote }), baseTask(), NO_COMMENTS);
    expect(ctx.internalNote).toHaveLength(INTERNAL_NOTE_MAX_CHARS);
  });

  // ── Task 2.7 — equipmentEvents capped at EQUIPMENT_EVENTS_MAX ─────────────
  it('caps equipmentEvents at EQUIPMENT_EVENTS_MAX entries', () => {
    const events = Array.from({ length: 25 }, (_, i) =>
      equipmentEvent({ serialNumber: `SN${i}` }),
    );
    const ctx = buildAuditContext(baseOrder({ equipmentEvents: events }), baseTask(), NO_COMMENTS);
    expect(ctx.equipmentEvents).toHaveLength(EQUIPMENT_EVENTS_MAX);
  });
});
