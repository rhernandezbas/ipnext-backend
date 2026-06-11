import { AddTicketCommentSchema } from '../../application/dto/ticketComments.dto';

// Build a base64 data-URI whose decoded byte length == `bytes`.
// 3 raw bytes → 4 base64 chars (no padding). We keep it simple: use bytes that are
// multiples of 3 so there is no padding and decoded length === bytes exactly.
function dataUri(bytes: number, mime = 'image/png'): { url: string; sizeBytes: number } {
  const b64chars = Math.ceil(bytes / 3) * 4; // safe upper bound, may add padding
  // Build exact decoded-length: use n triples → 3n bytes, 4n chars, no padding.
  const triples = Math.floor(bytes / 3);
  const remainder = bytes - triples * 3; // 0, 1 or 2
  let b64 = 'A'.repeat(triples * 4);
  if (remainder === 1) b64 += 'AA=='; // 1 byte
  else if (remainder === 2) b64 += 'AAA='; // 2 bytes
  void b64chars;
  return { url: `data:${mime};base64,${b64}`, sizeBytes: bytes };
}

describe('AddTicketCommentSchema', () => {
  it('accepts a valid data-URI image attachment', () => {
    const att = dataUri(1024, 'image/png');
    const res = AddTicketCommentSchema.safeParse({
      body: 'hi',
      attachments: [{ url: att.url, filename: 's.png', mimeType: 'image/png', sizeBytes: att.sizeBytes }],
    });
    expect(res.success).toBe(true);
  });

  it('accepts an image-only comment (no body)', () => {
    const att = dataUri(900, 'image/jpeg');
    const res = AddTicketCommentSchema.safeParse({
      attachments: [{ url: att.url, filename: 's.jpg', mimeType: 'image/jpeg', sizeBytes: att.sizeBytes }],
    });
    expect(res.success).toBe(true);
  });

  it('rejects a malformed data-URI', () => {
    const res = AddTicketCommentSchema.safeParse({
      body: 'x',
      attachments: [{ url: 'notadatauri', filename: 's.png', mimeType: 'image/png', sizeBytes: 10 }],
    });
    expect(res.success).toBe(false);
  });

  it('rejects when mimeType does not match the data-URI mime', () => {
    const att = dataUri(600, 'image/png');
    const res = AddTicketCommentSchema.safeParse({
      attachments: [{ url: att.url, filename: 's.png', mimeType: 'image/jpeg', sizeBytes: att.sizeBytes }],
    });
    expect(res.success).toBe(false);
  });

  it('rejects an image decoded >2MB', () => {
    const att = dataUri(2 * 1024 * 1024 + 3, 'image/png');
    const res = AddTicketCommentSchema.safeParse({
      attachments: [{ url: att.url, filename: 'big.png', mimeType: 'image/png', sizeBytes: att.sizeBytes }],
    });
    expect(res.success).toBe(false);
  });

  it('rejects when sizeBytes does not match the real decoded length', () => {
    const att = dataUri(900, 'image/png');
    const res = AddTicketCommentSchema.safeParse({
      attachments: [{ url: att.url, filename: 's.png', mimeType: 'image/png', sizeBytes: att.sizeBytes + 100 }],
    });
    expect(res.success).toBe(false);
  });

  it('rejects 4 attachments (max 3)', () => {
    const att = dataUri(300, 'image/png');
    const one = { url: att.url, filename: 's.png', mimeType: 'image/png', sizeBytes: att.sizeBytes };
    const res = AddTicketCommentSchema.safeParse({
      body: 'x',
      attachments: [one, one, one, one],
    });
    expect(res.success).toBe(false);
  });

  it('rejects an empty comment (no body and no attachments)', () => {
    const res = AddTicketCommentSchema.safeParse({ body: '   ', attachments: [] });
    expect(res.success).toBe(false);
  });

  it('rejects an SVG image (stored-XSS vector)', () => {
    // A tiny valid base64 (3 bytes) but with an SVG mime — must be rejected.
    const res = AddTicketCommentSchema.safeParse({
      attachments: [
        { url: 'data:image/svg+xml;base64,AAAA', filename: 'x.svg', mimeType: 'image/svg+xml', sizeBytes: 3 },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('rejects an SVG variant mimeType (image/svg)', () => {
    const res = AddTicketCommentSchema.safeParse({
      attachments: [
        { url: 'data:image/svg;base64,AAAA', filename: 'x.svg', mimeType: 'image/svg', sizeBytes: 3 },
      ],
    });
    expect(res.success).toBe(false);
  });
});
