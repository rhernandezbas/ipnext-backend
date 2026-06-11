/**
 * ListIClassNodes — use case de listado de nodos IClass disponibles.
 *
 * Envuelve IClassPort.listNodes() y mapea cada IClassNodeDescriptor a IClassNodeDTO.
 * Reusado por el GET /api/scheduling/iclass/nodes (dropdown de seleccion manual).
 *
 * Traza: REQ-NODES-1, REQ-NODES-5.
 */
import { IClassPort } from '@domain/ports/IClassPort';

export interface IClassNodeDTO {
  code: string;
  description: string;
}

export class ListIClassNodes {
  constructor(private readonly iclass: IClassPort) {}

  async execute(): Promise<{ nodes: IClassNodeDTO[] }> {
    const nodes = await this.iclass.listNodes();
    return {
      nodes: nodes.map(n => ({ code: n.code, description: n.description })),
    };
  }
}
