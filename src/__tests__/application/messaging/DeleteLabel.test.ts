/**
 * conversation-labels (Ola 5) — DeleteLabel: borra una etiqueta del catálogo. A
 * DIFERENCIA de DeleteTicketArea NO hay guard "en uso": borrar cascadea (onDelete
 * Cascade en la join). Solo valida existencia (404).
 */
import { DeleteLabel } from '@application/use-cases/messaging/DeleteLabel';
import { ConversationLabelNotFoundError } from '@domain/errors/messaging';
import { ListLabels } from '@application/use-cases/messaging/ListLabels';
import { InMemoryConversationLabelRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationLabelRepository';

describe('DeleteLabel', () => {
  let repo: InMemoryConversationLabelRepository;
  let deleteLabel: DeleteLabel;

  beforeEach(() => {
    repo = new InMemoryConversationLabelRepository();
    deleteLabel = new DeleteLabel(repo);
  });

  it('borra la label existente (sin guard de uso — cascadea)', async () => {
    const label = await repo.create({ name: 'Urgente', color: '#ef4444' });
    await deleteLabel.execute(label.id);
    expect(await new ListLabels(repo).execute()).toHaveLength(0);
  });

  it('id inexistente → ConversationLabelNotFoundError (404)', async () => {
    await expect(deleteLabel.execute('ghost')).rejects.toBeInstanceOf(ConversationLabelNotFoundError);
  });
});

describe('ListLabels', () => {
  it('devuelve el catálogo completo', async () => {
    const repo = new InMemoryConversationLabelRepository();
    await repo.create({ name: 'Urgente', color: '#ef4444' });
    await repo.create({ name: 'Ventas', color: '#22c55e' });
    const labels = await new ListLabels(repo).execute();
    expect(labels.map((l) => l.name).sort()).toEqual(['Urgente', 'Ventas']);
  });
});
