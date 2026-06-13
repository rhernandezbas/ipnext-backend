import { RecaptureLead, RecaptureContact, RecaptureLeadStatus } from '@domain/entities/recaptureLead';
import {
  RecaptureRepository,
  ListRecaptureLeadsQuery,
  CreateRecaptureLeadData,
  AddContactData,
  RecaptureLeadWithContacts,
} from '@domain/ports/RecaptureRepository';
import { PaginatedResult } from '@application/dto/pagination';

function nowIso(): string {
  return new Date().toISOString();
}

export class InMemoryRecaptureRepository implements RecaptureRepository {
  private leads: RecaptureLead[] = [];
  private contacts: RecaptureContact[] = [];
  private nextLeadId = 1;
  private nextContactId = 1;

  private newLeadId(): string {
    return `lead-${String(this.nextLeadId++).padStart(3, '0')}`;
  }

  private newContactId(): string {
    return `contact-${String(this.nextContactId++).padStart(3, '0')}`;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Reset state between tests */
  reset(): void {
    this.leads = [];
    this.contacts = [];
    this.nextLeadId = 1;
    this.nextContactId = 1;
  }

  /** Seed a lead directly (bypasses idempotency check — test helper) */
  seedLead(lead: RecaptureLead): void {
    this.leads.push(lead);
  }

  // ─── Port implementations ────────────────────────────────────────────────────

  async list(query: ListRecaptureLeadsQuery): Promise<PaginatedResult<RecaptureLead>> {
    let results = [...this.leads];

    if (query.source) {
      results = results.filter((l) => l.source === query.source);
    }
    if (query.status) {
      results = results.filter((l) => l.status === query.status);
    }
    if (query.unassigned) {
      results = results.filter((l) => l.assigneeId === null);
    } else if (query.assigneeId) {
      results = results.filter((l) => l.assigneeId === query.assigneeId);
    }

    const total = results.length;
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const start = (page - 1) * limit;
    const data = results.slice(start, start + limit);

    return { data, total, page, limit };
  }

  async getById(id: string): Promise<RecaptureLeadWithContacts | null> {
    const lead = this.leads.find((l) => l.id === id) ?? null;
    if (!lead) return null;

    const contacts = this.contacts
      .filter((c) => c.leadId === id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return { ...lead, contacts };
  }

  async create(data: CreateRecaptureLeadData): Promise<RecaptureLead> {
    const now = nowIso();
    const lead: RecaptureLead = {
      id: this.newLeadId(),
      source: data.source,
      clientId: data.clientId ?? null,
      contactName: data.contactName,
      phone: data.phone ?? null,
      email: data.email ?? null,
      status: 'nuevo',
      assigneeId: null,
      // InMemory does not resolve user names — name resolution is a Prisma-projection concern.
      assigneeName: null,
      claimedAt: null,
      createdAt: now,
      updatedAt: now,
      address: data.address ?? null,
      churnReason: data.churnReason ?? null,
      previousPlan: data.previousPlan ?? null,
    };
    this.leads.push(lead);
    return lead;
  }

  /**
   * Atomic claim: assigns the lead to `actorId` only when `assigneeId === null`.
   * Returns the updated lead, or null if it was already claimed.
   * This is synchronous (in-memory) so the check-and-set is race-free in the test context.
   */
  async claim(leadId: string, actorId: string): Promise<RecaptureLead | null> {
    const idx = this.leads.findIndex((l) => l.id === leadId);
    if (idx === -1) return null;

    const lead = this.leads[idx]!;
    // Guard: only succeed when unassigned
    if (lead.assigneeId !== null) return null;

    const now = nowIso();
    const updated: RecaptureLead = {
      ...lead,
      assigneeId: actorId,
      // InMemory does not resolve assigneeName — name resolution is Prisma-only.
      assigneeName: null,
      claimedAt: now,
      status: 'en_gestion',
      updatedAt: now,
    };
    this.leads[idx] = updated;
    return updated;
  }

  /**
   * Claim the oldest free lead (status='nuevo', assigneeId IS NULL, ordered by createdAt asc).
   * Returns the claimed lead or null if none is available.
   */
  async claimNext(actorId: string): Promise<RecaptureLead | null> {
    const free = this.leads
      .filter((l) => l.status === 'nuevo' && l.assigneeId === null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    if (free.length === 0) return null;

    return this.claim(free[0]!.id, actorId);
  }

  async release(leadId: string): Promise<RecaptureLead | null> {
    const idx = this.leads.findIndex((l) => l.id === leadId);
    if (idx === -1) return null;

    const now = nowIso();
    const updated: RecaptureLead = {
      ...this.leads[idx]!,
      assigneeId: null,
      claimedAt: null,
      status: 'nuevo',
      updatedAt: now,
    };
    this.leads[idx] = updated;
    return updated;
  }

  async updateStatus(leadId: string, status: RecaptureLeadStatus): Promise<RecaptureLead | null> {
    const idx = this.leads.findIndex((l) => l.id === leadId);
    if (idx === -1) return null;

    const updated: RecaptureLead = {
      ...this.leads[idx]!,
      status,
      updatedAt: nowIso(),
    };
    this.leads[idx] = updated;
    return updated;
  }

  async addContact(data: AddContactData): Promise<RecaptureContact> {
    const now = nowIso();
    const contact: RecaptureContact = {
      id: this.newContactId(),
      leadId: data.leadId,
      actorId: data.actorId,
      channel: data.channel,
      outcome: data.outcome,
      proposal: data.proposal ?? null,
      note: data.note ?? null,
      nextStepAt: data.nextStepAt ?? null,
      createdAt: now,
    };
    this.contacts.push(contact);

    // Optionally advance lead status
    if (data.advanceStatus) {
      await this.updateStatus(data.leadId, data.advanceStatus);
    }

    return contact;
  }

  async ingestChurned(
    clients: Array<{ id: string; name: string; phone?: string | null; email?: string | null }>,
  ): Promise<number> {
    let created = 0;

    for (const client of clients) {
      // Idempotency: skip if a churned_client lead already exists for this clientId
      const existing = this.leads.find(
        (l) => l.source === 'churned_client' && l.clientId === client.id,
      );
      if (existing) continue;

      await this.create({
        source: 'churned_client',
        clientId: client.id,
        contactName: client.name,
        phone: client.phone,
        email: client.email,
      });
      created++;
    }

    return created;
  }
}
