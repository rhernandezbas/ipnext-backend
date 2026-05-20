import { z } from 'zod';

export const ReplaceTemplateItemsSchema = z.object({
  items: z.array(
    z.object({ text: z.string().min(1).max(500) })
  ),
});

export const AddChecklistItemSchema = z.object({
  text: z.string().min(1).max(500),
});

export const UpdateChecklistItemSchema = z.object({
  text: z.string().min(1).max(500),
});

export const ReorderChecklistSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(0),
});

export const AssignTemplateSchema = z.object({
  templateId: z.string().min(1),
});

// Toggle and Clear have no body — validated by path params only.

export type ReplaceTemplateItemsInput = z.infer<typeof ReplaceTemplateItemsSchema>;
export type AddChecklistItemInput    = z.infer<typeof AddChecklistItemSchema>;
export type UpdateChecklistItemInput = z.infer<typeof UpdateChecklistItemSchema>;
export type ReorderChecklistInput    = z.infer<typeof ReorderChecklistSchema>;
export type AssignTemplateInput      = z.infer<typeof AssignTemplateSchema>;
