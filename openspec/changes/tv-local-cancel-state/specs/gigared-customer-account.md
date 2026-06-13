# Spec delta — gigared-customer-account (#72)

## MODIFIED Requirement: Estado de vínculo TV del cliente

`GET /api/gigared/customers/:id/account` refleja el flag local de baja además del estado
real del partner.

### Scenario: cliente con baja TV local
- WHEN `Client.tvCancelledAt` está seteado
- THEN responde `{ linked: false, account: null }` SIN llamar al partner
- AND el panel muestra los formularios de vincular/registrar (cuenta "no vinculada")
  aunque la cuenta del partner siga resolviendo por internal_id

### Scenario: re-vinculación limpia el flag
- WHEN un `link` o `register` se completa con éxito
- THEN `clearCancelled` limpia `Client.tvCancelledAt` (best-effort)
- AND el panel vuelve a mostrar la cuenta vinculada con sus packs
