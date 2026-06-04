import { AUDIT_SEVERITIES, AUDIT_CATEGORIES } from '@domain/entities/installation-audit';

/**
 * JSON Schema handed to Ollama as `format` (structured outputs) so the vision
 * model is grammar-constrained to emit EXACTLY an array of findings with valid
 * severity/category enums — instead of a free-form `{status, issues}` object or
 * degenerate `<|im_start|>` token loops (the failure modes seen with `format:
 * 'json'`). Enums come from the domain constants so they never drift. `photoUrls`
 * is intentionally omitted (the model can't know the URLs; the parser defaults []).
 */
export function auditFormatSchema(): Record<string, unknown> {
  return {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: [...AUDIT_SEVERITIES] },
        category: { type: 'string', enum: [...AUDIT_CATEGORIES] },
        text: { type: 'string' },
      },
      required: ['severity', 'category', 'text'],
    },
  };
}
