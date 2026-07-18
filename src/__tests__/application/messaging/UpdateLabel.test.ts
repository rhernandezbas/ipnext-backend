/**
 * conversation-labels (Ola 5) — UpdateLabel: name/color de una etiqueta. 404 si no
 * existe; 409 si el nuevo name colisiona (case-insensitive). Clon de UpdateTicketArea.
 */
import { UpdateLabel } from '@application/use-cases/messaging/UpdateLabel';
import {
  ConversationLabelNotFoundError,
  ConversationLabelNameConflictError,
} from '@domain/errors/messaging';
import { InMemoryConversationLabelRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationLabelRepository';

describe('UpdateLabel', () => {
  let repo: InMemoryConversationLabelRepository;
  let updateLabel: UpdateLabel;

  beforeEach(() => {
    repo = new InMemoryConversationLabelRepository();
    updateLabel = new UpdateLabel(repo);
  });

  it('actualiza name y color', async () => {
    const label = await repo.create({ name: 'Urgente', color: '#ef4444' });
    const updated = await updateLabel.execute(label.id, { name: 'Muy urgente', color: '#dc2626' });
    expect(updated.name).toBe('Muy urgente');
    expect(updated.color).toBe('#dc2626');
  });

  it('id inexistente → ConversationLabelNotFoundError (404)', async () => {
    await expect(updateLabel.execute('ghost', { name: 'X' })).rejects.toBeInstanceOf(
      ConversationLabelNotFoundError,
    );
  });

  it('name que colisiona con otra label → ConversationLabelNameConflictError (409)', async () => {
    await repo.create({ name: 'Ventas', color: '#22c55e' });
    const other = await repo.create({ name: 'Urgente', color: '#ef4444' });
    await expect(updateLabel.execute(other.id, { name: 'ventas' })).rejects.toBeInstanceOf(
      ConversationLabelNameConflictError,
    );
  });

  it('re-guardar el MISMO name (mismo id) no dispara conflicto', async () => {
    const label = await repo.create({ name: 'Urgente', color: '#ef4444' });
    const updated = await updateLabel.execute(label.id, { name: 'Urgente', color: '#000000' });
    expect(updated.color).toBe('#000000');
  });
});
