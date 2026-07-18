import { z } from 'zod';

/**
 * conversation-labels (Ola 5) — Zod para el CRUD del catálogo de etiquetas y el
 * set de labels de una conversación. Reusa el MISMO patrón hex de #69
 * (`tickets.dto.ts` HexColorSchema) — 6-digit hex, rechaza cualquier otra cosa
 * en el borde.
 */
const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be a 6-digit hex like #6366f1');

export const CreateLabelSchema = z.object({
  name: z.string().trim().min(1),
  color: HexColorSchema,
});

// PUT parcial (mismo criterio que UpdateTicketAreaSchema): name/color opcionales.
export const UpdateLabelSchema = CreateLabelSchema.partial();

/**
 * Body de `PATCH /conversations/:id/labels`: `labelIds` DEBE ser un array de
 * strings no-vacíos (array vacío = limpiar todas las labels, VÁLIDO). El use case
 * deduplica y valida existencia.
 */
export const SetConversationLabelsSchema = z.object({
  labelIds: z.array(z.string().min(1)),
});

export type CreateLabelInput = z.infer<typeof CreateLabelSchema>;
export type UpdateLabelInput = z.infer<typeof UpdateLabelSchema>;
export type SetConversationLabelsInput = z.infer<typeof SetConversationLabelsSchema>;
