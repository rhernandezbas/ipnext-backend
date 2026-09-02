/**
 * external-bulk-messaging fix wave F1 (finding F8) — logins de los usuarios
 * MAQUINA (`RbacUser` de sistema) que el DOMINIO/APLICACION necesitan nombrar.
 *
 * Por que aca y no en `infrastructure/bootstrap/`: el login es el
 * DISCRIMINADOR de negocio del caller M2M (`Campaign.createdById` = el
 * `api-messaging`, D2) — `ValidateExternalBulk`/`SendExternalBulk`/
 * `GetExternalBulkCampaign` lo usan para resolver el creador del cupo diario y
 * para acotar el status a campanas propias (STATUS-1). Importarlo desde
 * `@infrastructure/bootstrap/...` era una violacion DIP directa (CLAUDE.md,
 * "DIP estricto"), pineada ahora por `domainLayerPurity.test.ts`.
 *
 * El modulo de bootstrap sigue siendo el que CREA la fila; solo re-exporta esta
 * constante para no romper a sus consumidores de infraestructura/tests.
 */

/** D2 — `RbacUser.login` del caller M2M de envio masivo WhatsApp (external-bulk-messaging). */
export const API_MESSAGING_USER_LOGIN = 'api-messaging';
