import { IncompleteSuggestionError } from '@domain/errors/inventory';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';

type SuggestionMinData = Pick<
  TaskInventorySuggestion,
  'id' | 'kind' | 'serialNumber' | 'mac' | 'materialDesc'
>;

/**
 * Validación mínima de completitud para una sugerencia de inventario.
 * Usada tanto en ConfirmInventorySuggestion (pre-confirm) como en
 * CreateManualSuggestion (pre-insert). Los mensajes son idénticos a los
 * que tenía el método privado `assertComplete` de ConfirmInventorySuggestion
 * para garantizar cero drift entre los dos flujos.
 */
export function assertSuggestionComplete(s: SuggestionMinData): void {
  if (s.kind === 'DEVICE') {
    if (!s.serialNumber?.trim() && !s.mac?.trim()) {
      throw new IncompleteSuggestionError(s.id, 'DEVICE requiere SN o MAC');
    }
  } else {
    if (!s.materialDesc?.trim()) {
      throw new IncompleteSuggestionError(s.id, 'MATERIAL requiere descripción');
    }
  }
}
