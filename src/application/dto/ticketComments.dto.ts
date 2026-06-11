import { z } from 'zod';

// SVG is excluded on purpose: it can carry <script>, so an inline SVG image is a
// stored-XSS vector. We reject `image/svg`, `image/svg+xml`, etc. — in both the
// data-URI mime group and the mimeType whitelist.
const SVG_MIME_RE = /^image\/svg/i;
const DATA_URI_RE = /^data:(image\/(?!svg)[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export const TicketCommentAttachmentSchema = z
  .object({
    url: z.string().regex(DATA_URI_RE),
    filename: z.string().min(1),
    mimeType: z.string().regex(/^image\//).refine((m) => !SVG_MIME_RE.test(m), {
      message: 'SVG images are not allowed',
    }),
    sizeBytes: z.number().int().positive(),
  })
  .superRefine((a, ctx) => {
    const m = DATA_URI_RE.exec(a.url);
    if (!m) return;
    const [, mime, b64] = m;
    const real =
      Math.floor((b64!.length * 3) / 4) -
      (b64!.endsWith('==') ? 2 : b64!.endsWith('=') ? 1 : 0);
    if (real > MAX_IMAGE_BYTES) ctx.addIssue({ code: 'custom', message: 'image exceeds 2MB' });
    if (real !== a.sizeBytes) ctx.addIssue({ code: 'custom', message: 'sizeBytes mismatch' });
    if (a.mimeType !== mime) ctx.addIssue({ code: 'custom', message: 'mimeType mismatch' });
  });

export const AddTicketCommentSchema = z
  .object({
    body: z.string().default(''),
    authorName: z.string().min(1).optional(),
    attachments: z.array(TicketCommentAttachmentSchema).max(3).default([]),
  })
  .refine((d) => d.body.trim().length > 0 || d.attachments.length > 0);

export type AddTicketCommentDto = z.infer<typeof AddTicketCommentSchema>;
