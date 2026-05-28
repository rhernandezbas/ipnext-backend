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

describe('CreateTaskSchema — phase 2: legacy fields stripped', () => {
  it('legacy fields in body are not present in parsed output (assignedTo)', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, assignedTo: 'Carlos' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect('assignedTo' in r.data).toBe(false);
    }
  });

  it('legacy fields in body are not present in parsed output (assignedToId)', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, assignedToId: 'admin-1' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect('assignedToId' in r.data).toBe(false);
    }
  });

  it('legacy fields in body are not present in parsed output (clientId)', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, clientId: 'cli-1' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect('clientId' in r.data).toBe(false);
    }
  });

  it('legacy fields in body are not present in parsed output (clientName)', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, clientName: 'Juan' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect('clientName' in r.data).toBe(false);
    }
  });

  it('legacy fields in body are not present in parsed output (scheduledDate)', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, scheduledDate: '2026-05-10' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect('scheduledDate' in r.data).toBe(false);
    }
  });

  it('legacy fields in body are not present in parsed output (scheduledTime)', () => {
    const r = CreateTaskSchema.safeParse({ ...BASE_VALID, scheduledTime: '09:00' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect('scheduledTime' in r.data).toBe(false);
    }
  });

  it('accepts body with only required fields (no legacy fields)', () => {
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

// Regression guard: UpdateTaskSchema MUST keep accepting `null` for the
// optional FK fields (mirrors CreateTaskSchema via .partial() on the shared
// base). Empty strings are still rejected by `min(1)` — clients must
// normalise "no value" to null at the boundary. If this contract drifts
// (e.g. someone redefines the field as `z.string().min(1).optional()` without
// `.nullable()`), the FE "Sin asignar / Sin partner / Sin servicio" flow
// breaks silently with 400 VALIDATION_ERROR.
describe('UpdateTaskSchema — FK nullability contract', () => {
  it.each([
    ['assigneeId'],
    ['partnerId'],
    ['serviceId'],
    ['reporterId'],
    ['customerId'],
    ['projectId'],
  ])('accepts %s: null (clears the FK)', (field) => {
    const r = UpdateTaskSchema.safeParse({ [field]: null });
    expect(r.success).toBe(true);
  });

  // Note: projectId is NOT in this set because its schema is just
  // `z.string().nullable().optional()` (no `.min(1)`) — it tolerates empty
  // string today. The strict-FK fields below all carry `.min(1)`, so the
  // empty string MUST be rejected and the client MUST normalise to null.
  it.each([
    ['assigneeId'],
    ['partnerId'],
    ['serviceId'],
    ['reporterId'],
    ['customerId'],
  ])('rejects %s: "" (clients must normalise empty string to null)', (field) => {
    const r = UpdateTaskSchema.safeParse({ [field]: '' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map(i => i.path[0]);
      expect(paths).toContain(field);
    }
  });
});
