import { auditFormatSchema } from '@infrastructure/adapters/audit/auditFormatSchema';
import { AUDIT_SEVERITIES, AUDIT_CATEGORIES } from '@domain/entities/installation-audit';

describe('auditFormatSchema', () => {
  it('builds an array JSON schema for Ollama structured outputs with enums from the domain constants', () => {
    const s = auditFormatSchema() as any;
    expect(s.type).toBe('array');
    expect(s.items.type).toBe('object');
    expect(s.items.properties.severity.enum).toEqual([...AUDIT_SEVERITIES]);
    expect(s.items.properties.category.enum).toEqual([...AUDIT_CATEGORIES]);
    expect(s.items.properties.text.type).toBe('string');
    expect(s.items.required).toEqual(['severity', 'category', 'text']);
    // photoUrls must NOT be in the schema — the model can't know the URLs; the
    // parser defaults them to []. Constraining it would force hallucinated URLs.
    expect(s.items.properties.photoUrls).toBeUndefined();
  });
});
