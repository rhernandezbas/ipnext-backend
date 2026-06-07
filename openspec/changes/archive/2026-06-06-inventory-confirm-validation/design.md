# Design — inventory-confirm-validation (#18)

BE (fail-closed) + FE (UX). Sin migración.

## Backend

### 1. Error de dominio
`domain/errors/inventory.ts`: nuevo
```ts
export class IncompleteSuggestionError extends DomainError {
  constructor(id: string, reason: string) {
    super(`Inventory suggestion ${id} is incomplete: ${reason}`, 'SUGGESTION_INCOMPLETE');
    this.name = 'IncompleteSuggestionError';
  }
}
```

### 2. Guard en el caso de uso
`ConfirmInventorySuggestion`: helper privado + guard al inicio de `execute()` (después del check de `already confirmed`, antes de `getTask`) y de `replace()` (después del check `kind !== DEVICE`).
```ts
private assertComplete(s: TaskInventorySuggestion): void {
  if (s.kind === 'DEVICE') {
    if (!s.serialNumber?.trim() && !s.mac?.trim())
      throw new IncompleteSuggestionError(s.id, 'DEVICE requiere SN o MAC');
  } else { // MATERIAL
    if (!s.materialDesc?.trim())
      throw new IncompleteSuggestionError(s.id, 'MATERIAL requiere descripción');
  }
}
```
- `execute()`: llamar `this.assertComplete(suggestion)` antes de ramificar por kind. Cubre los 3 paths (material, same_device link_existing, add) — y `same_device` siempre tiene SN/MAC (hubo match), así que el guard no lo rompe.
- `replace()`: es DEVICE only; llamar `this.assertComplete(suggestion)` tras el check de kind.

### 3. Mapeo HTTP
`infrastructure/http/middleware/errorHandler.ts`: agregar al `statusMap` → `SUGGESTION_INCOMPLETE: 422`. (El handler ya hace `statusMap[err.code] ?? 400`; sin la entrada daría 400 — 422 es más semántico.) La ruta `/confirm` y `/replace` ya delegan con `next(e)` → no se tocan.

## Frontend

`SuggestionCard.tsx`: computar el flag y deshabilitar los botones de confirmación (no el de descartar).
```ts
const incomplete = isDevice
  ? (!s.serialNumber?.trim() && !s.mac?.trim())
  : !s.materialDesc?.trim();
```
- Deshabilitar con `disabled={isPending || incomplete}` los botones "Confirmar", "Agregar" y "Marcar como ya instalado" (este último es same_device → en la práctica nunca incompleto, pero consistente).
- Hint cuando `incomplete && !resolved && canWrite`: un `<span>` chico ("Falta SN o MAC para confirmar" / "Falta una descripción"). "Descartar" queda habilitado siempre.

## Tests (TDD)

### BE — `ConfirmInventorySuggestion.test.ts`
- DEVICE sin SN ni MAC → `execute` rechaza con `IncompleteSuggestionError`, no crea item (inventory repo vacío).
- DEVICE con SN (mac null) → confirma OK.
- MATERIAL sin `materialDesc` → `execute` rechaza, no crea consumption.
- MATERIAL con desc → confirma OK.
- `replace()` con DEVICE sin SN/MAC → rechaza.

### FE — `SuggestionCard.test.tsx`
- DEVICE sin SN/MAC → "Confirmar" deshabilitado + hint visible; "Descartar" habilitado.
- DEVICE con SN → "Confirmar" habilitado.
- MATERIAL sin desc → "Confirmar" deshabilitado.

## Riesgos
- Bajo. Guard que solo rechaza confirmaciones inválidas; el camino feliz no cambia. Sin migración, sin tocar datos existentes.
- `same_device` link_existing: tiene SN/MAC por definición del match → el guard no lo afecta (verificar en el test del path si hace falta).
