/**
 * Change 3 (templates CRUD) — DTOs curados para el CRUD de templates WhatsApp
 * (VER/CREAR/SUBMIT/BORRAR directo a Twilio Content API). Archivo NUEVO, NO pisa
 * `messaging-bulk.dto.ts` (evita merge con C2/F2).
 *
 * Regla dura: la superficie HTTP y los use cases NUNCA ven ni devuelven el JSON
 * crudo de Twilio — se mapea a estos DTOs curados.
 */
import type { TemplateDto } from '@domain/ports/TemplateMessagingPort';

/** Categorías de aprobación válidas (Twilio/Meta). */
export const TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export function isTemplateCategory(value: unknown): value is TemplateCategory {
  return typeof value === 'string' && (TEMPLATE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Input HTTP de creación de template. `category` es opcional acá (Twilio NO la
 * usa en el POST de creación — la categoría se fija recién al SUBMIT), pero se
 * valida contra el enum si viene. `variables` = nombres/índices declarados
 * (ej. `['1','2']`); el use case los mapea al `Record` índice→sample que espera
 * el proveedor.
 */
export interface CreateTemplateInput {
  friendlyName: string;
  language: string;
  category?: string;
  body: string;
  variables?: string[];
}

/** Input HTTP de submit-a-Meta. */
export interface SubmitTemplateInput {
  name: string;
  category: string;
}

/**
 * DTO curado de un template (ficha/detalle + item de listado). Igual forma que
 * `TemplateSummaryDto` de messaging-bulk, pero definido acá para no acoplar este
 * change al archivo de F2/C2.
 */
export interface TemplateDetailDto {
  contentSid: string;
  friendlyName: string;
  language: string;
  /** Nombres/índices de variable declarados (keys de `TemplateDto.variables`). */
  variables: string[];
  approvalStatus: TemplateDto['approvalStatus'];
  category?: string;
  /** `true` solo si `approvalStatus === 'approved'`. */
  sendable: boolean;
  /** Texto plano del template (ver `TemplateDto.body`). `''` si no declara body. */
  body: string;
  /**
   * fix wave F5 (HIGH) — motivo de rechazo de Meta, tal cual `TemplateDto.rejectionReason` (F4/S4).
   * Additivo. El adapter YA lo completaba (`TwilioContentGateway.toTemplateDto`) pero moría acá: el
   * mapper lo descartaba antes de llegar al wire — `GET .../templates/:sid` respondía 200 sin el
   * campo aunque el proveedor lo hubiera informado.
   */
  rejectionReason?: string | null;
  /**
   * fix wave F5 (HIGH) — categoría según el endpoint dedicado de aprobación, tal cual
   * `TemplateDto.approvalCategory` (F4/S4). SOLO se completa en `GET .../templates/:sid` (viene del
   * merge con `ApprovalRequests`); en el listado queda `undefined`. Mismo bug de mapper que
   * `rejectionReason` — moría acá, nunca llegaba al wire.
   */
  approvalCategory?: string | null;
  /**
   * fix wave F5 (LOW) — status crudo del proveedor, tal cual `TemplateDto.providerStatus`. Ver el
   * docstring del port: cubre `paused`/`disabled` (Twilio-only, fuera del union `approvalStatus`).
   */
  providerStatus?: string;
}

/** Mapper puro `TemplateDto` (dominio) → `TemplateDetailDto` (wire curado). */
export function toTemplateDetailDto(t: TemplateDto): TemplateDetailDto {
  return {
    contentSid: t.contentSid,
    friendlyName: t.friendlyName,
    language: t.language,
    variables: Object.keys(t.variables),
    approvalStatus: t.approvalStatus,
    category: t.category,
    sendable: t.approvalStatus === 'approved',
    body: t.body,
    rejectionReason: t.rejectionReason,
    approvalCategory: t.approvalCategory,
    providerStatus: t.providerStatus,
  };
}
