import { CreateTaskSchema, UpdateTaskSchema } from '../../../application/dto/scheduling.dto';

const BASE_VALID = {
  title: 'Test task',
  priority: 'normal' as const,
  estimatedHours: 1,
  category: 'installation' as const,
};

describe('CreateTaskSchema — new datetime fields', () => {
  it('accepts valid startDate ISO 8601 with offset', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, startDate: '2026-05-21T09:00:00-03:00' });
    expect(r.success).toBe(true);
  });

  it('accepts valid endDate ISO 8601 with offset', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, endDate: '2026-05-21T11:00:00-03:00' });
    expect(r.success).toBe(true);
  });

  it('rejects malformed startDate (DD/MM/YYYY HH:MM format)', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, startDate: '20/05/2026 09:00' });
    expect(r.success).toBe(false);
  });

  it('rejects when endDate < startDate', () => {
    const r = CreateTaskSchema.safeParse({
      ...BASE_VALID,
      startDate: '2026-05-21T11:00:00-03:00',
      endDate: '2026-05-21T09:00:00-03:00',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map(i => i.path[0]);
      expect(paths).toContain('endDate');
    }
  });

  it('accepts startDate === endDate (boundary)', () => {
    const r = CreateTaskSchema.safeParse({
      ...BASE_VALID,
      startDate: '2026-05-21T09:00:00-03:00',
      endDate: '2026-05-21T09:00:00-03:00',
    });
    expect(r.success).toBe(true);
  });

  it('accepts startDate as null', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, startDate: null });
    expect(r.success).toBe(true);
  });

  it('accepts startDate absent (undefined)', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID });
    expect(r.success).toBe(true);
  });
});

describe('CreateTaskSchema — new FK fields', () => {
  it('accepts customerId as min(1) string', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, customerId: 'cust-123' });
    expect(r.success).toBe(true);
  });

  it('accepts serviceId, partnerId, reporterId, assigneeId as min(1) strings', () => {
    const r = CreateTaskSchema.safeParse({
      ...BASE_VALID,
      serviceId: 'svc-1',
      partnerId: 'part-1',
      reporterId: 'rep-1',
      assigneeId: 'ass-1',
    });
    expect(r.success).toBe(true);
  });

  it('accepts watcherIds as string[]', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, watcherIds: ['w-1', 'w-2'] });
    expect(r.success).toBe(true);
  });

  it('accepts watcherIds as empty array', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, watcherIds: [] });
    expect(r.success).toBe(true);
  });

  it('accepts all FK fields as null', () => {
    const r = CreateTaskSchema.safeParse({
      ...BASE_VALID,
      customerId: null,
      serviceId: null,
      partnerId: null,
      reporterId: null,
      assigneeId: null,
    });
    expect(r.success).toBe(true);
  });
});

describe('CreateTaskSchema — travel time fields', () => {
  it('rejects negative travelTimeTo', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, travelTimeTo: -5 });
    expect(r.success).toBe(false);
  });

  it('rejects negative travelTimeFrom', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, travelTimeFrom: -1 });
    expect(r.success).toBe(false);
  });

  it('rejects non-integer travelTimeTo', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, travelTimeTo: 1.5 });
    expect(r.success).toBe(false);
  });

  it('rejects non-integer travelTimeFrom', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, travelTimeFrom: 2.7 });
    expect(r.success).toBe(false);
  });

  it('accepts zero travelTimeTo', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, travelTimeTo: 0 });
    expect(r.success).toBe(true);
  });

  it('accepts travelTimeTo as null', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, travelTimeTo: null });
    expect(r.success).toBe(true);
  });
});

describe('CreateTaskSchema — deprecated fields still optional (no breakage)', () => {
  it('still accepts scheduledDate and scheduledTime', () => {
    const r = CreateTaskSchema.safeParse({
      ...BASE_VALID,
      scheduledDate: '2026-05-10',
      scheduledTime: '09:00',
    });
    expect(r.success).toBe(true);
  });

  it('accepts body with only required fields (no deprecated fields)', () => {
    const r = CreateTaskSchema.safeParse(BASE_VALID);
    expect(r.success).toBe(true);
  });
});

describe('UpdateTaskSchema — partial shape', () => {
  it('accepts only watcherIds', () => {
    const r = UpdateTaskSchema.safeParse({ watcherIds: ['a', 'b'] });
    expect(r.success).toBe(true);
  });

  it('accepts empty object', () => {
    const r = UpdateTaskSchema.safeParse({});
    expect(r.success).toBe(true);
  });
});
