import {
  ChatMessageAttachmentRepository,
  ChatMessageAttachmentRecord,
  UpsertChatMessageAttachmentInput,
  ListRetriableOptions,
  MarkDownloadedInput,
  MarkFailedInput,
} from '@domain/ports/ChatMessageAttachmentRepository';
import { ChatAttachmentNotFoundError } from '@domain/errors/chatAttachment';
import { prisma } from '../../database/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value instanceof Date ? value.toISOString() : (value as string);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDomain(row: any): ChatMessageAttachmentRecord {
  return {
    id: row.id,
    messageId: row.messageId,
    chatwootAttachmentId: row.chatwootAttachmentId,
    fileType: row.fileType,
    contentType: row.contentType,
    filename: row.filename ?? null,
    sizeBytes: row.sizeBytes ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    storageKey: row.storageKey ?? null,
    thumbStorageKey: row.thumbStorageKey ?? null,
    sourceUrl: row.sourceUrl,
    thumbSourceUrl: row.thumbSourceUrl ?? null,
    status: row.status,
    downloadAttempts: row.downloadAttempts,
    lastError: row.lastError ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

/**
 * messaging-inbox-v2-media (Tanda 1 · B1.5) — Prisma adapter for
 * `ChatMessageAttachmentRepository`. Most of the contract is exercised via the
 * in-memory port in use-case/scheduler tests (never mock Prisma for THOSE); this
 * adapter is additionally unit-tested directly (mocked Prisma singleton,
 * `PrismaChatMessageAttachmentRepository.test.ts`, fix wave) for the handful of
 * behaviors that only exist at the Prisma layer and can't be reproduced by the
 * in-memory fake: the `updateMany`-guarded `markFailed` race (fix-be #2), the
 * P2002 retry-as-update on `upsert` (fix-be #4), and the null-vs-undefined
 * distinction on the `update` branch (fix-be #8).
 */
export class PrismaChatMessageAttachmentRepository implements ChatMessageAttachmentRepository {
  async upsertByChatwootAttachmentId(
    input: UpsertChatMessageAttachmentInput,
  ): Promise<ChatMessageAttachmentRecord> {
    // fix-be #8 (BAJO) — passed through AS-IS (no `?? undefined`): an ABSENT key on
    // `input` reads as `undefined` here, which Prisma treats as "leave this field
    // untouched" in an `update`. An EXPLICIT `null` (Chatwoot corrected a field to
    // "no value") must reach Prisma as a real `null` so it actually CLEARS the
    // column — collapsing both cases to `undefined` (the old `?? undefined`) silently
    // dropped that correction and left a stale value stuck forever. Same H3 idiom as
    // `HttpChatwootGateway.toIsoOrUndefined`.
    const updateData = {
      messageId: input.messageId,
      fileType: input.fileType,
      contentType: input.contentType,
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      width: input.width,
      height: input.height,
      sourceUrl: input.sourceUrl,
      thumbSourceUrl: input.thumbSourceUrl,
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await (prisma as any).chatMessageAttachment.upsert({
        where: { chatwootAttachmentId: input.chatwootAttachmentId },
        create: {
          messageId: input.messageId,
          chatwootAttachmentId: input.chatwootAttachmentId,
          fileType: input.fileType,
          contentType: input.contentType,
          filename: input.filename ?? null,
          sizeBytes: input.sizeBytes ?? null,
          width: input.width ?? null,
          height: input.height ?? null,
          sourceUrl: input.sourceUrl,
          thumbSourceUrl: input.thumbSourceUrl ?? null,
        },
        // Scenario 2 — an already-`downloaded` row must NOT be reverted: `status`,
        // `storageKey` and `thumbStorageKey` are deliberately absent from `update`, so
        // Prisma leaves them untouched. Only metadata Chatwoot may have corrected updates.
        update: updateData,
      });
      return toDomain(row);
    } catch (e) {
      // fix-be #4 (LOW-MEDIUM) — Prisma's `upsert` is NOT a single atomic SQL
      // statement here: it's effectively SELECT-then-INSERT-or-UPDATE. Two truly
      // concurrent deliveries for the SAME `chatwootAttachmentId` can both observe
      // "not found" and both attempt the INSERT — the loser gets a P2002 unique
      // violation instead of a clean update. Retrying as a plain UPDATE resolves the
      // loser onto the row the winner just created, instead of propagating a
      // transient 500 for what is actually a legitimate concurrent webhook delivery.
      if ((e as { code?: string } | null)?.code === 'P2002') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = await (prisma as any).chatMessageAttachment.update({
          where: { chatwootAttachmentId: input.chatwootAttachmentId },
          data: updateData,
        });
        return toDomain(row);
      }
      throw e;
    }
  }

  async listByMessageIds(messageIds: string[]): Promise<ChatMessageAttachmentRecord[]> {
    if (messageIds.length === 0) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).chatMessageAttachment.findMany({
      where: { messageId: { in: messageIds } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => toDomain(r));
  }

  async findById(id: string): Promise<ChatMessageAttachmentRecord | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).chatMessageAttachment.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async listRetriable(options: ListRetriableOptions): Promise<ChatMessageAttachmentRecord[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).chatMessageAttachment.findMany({
      where: {
        status: { in: ['pending', 'failed'] },
        downloadAttempts: { lt: options.maxAttempts },
      },
      ...(options.limit !== undefined ? { take: options.limit } : {}),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => toDomain(r));
  }

  async markDownloaded(id: string, input: MarkDownloadedInput): Promise<ChatMessageAttachmentRecord> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await (prisma as any).chatMessageAttachment.update({
        where: { id },
        data: {
          status: 'downloaded',
          storageKey: input.storageKey,
          thumbStorageKey: input.thumbStorageKey ?? null,
        },
      });
      return toDomain(row);
    } catch (e) {
      if ((e as { code?: string } | null)?.code === 'P2025') throw new ChatAttachmentNotFoundError(id);
      throw e;
    }
  }

  async markFailed(id: string, input: MarkFailedInput): Promise<ChatMessageAttachmentRecord> {
    // fix-be #2 (MEDIUM) — the fire-and-forget (web process) and the scheduler (or
    // another replica) can race on the SAME row: an unconditional `update` here would
    // let a slower/stale `markFailed` revert a row the fire-and-forget already marked
    // `downloaded` (storageKey already set, binary already safely stored). Guarding
    // the WHERE clause with `status: {not: 'downloaded'}` makes the "never revert a
    // winning download" rule atomic at the DB level instead of a check-then-act race.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).chatMessageAttachment.updateMany({
      where: { id, status: { not: 'downloaded' } },
      data: {
        status: 'failed',
        downloadAttempts: { increment: 1 },
        lastError: input.error,
      },
    });

    // `updateMany` never throws P2025 and returns only a `{ count }` — re-fetch to
    // return the definitive row either way: freshly-failed (count 1), untouched
    // downloaded (count 0, guard held), or a 404 if the id never existed at all.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).chatMessageAttachment.findUnique({ where: { id } });
    if (!row) throw new ChatAttachmentNotFoundError(id);
    return toDomain(row);
  }
}
