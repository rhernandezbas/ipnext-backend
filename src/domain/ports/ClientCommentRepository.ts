import { ClientComment } from '../entities/customer';

export interface ClientCommentRepository {
  findByClientId(clientId: string): Promise<ClientComment[]>;
  create(comment: ClientComment): Promise<ClientComment>;
}
