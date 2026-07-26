import type { ListTasks } from '@application/use-cases/ListTasks';
import type {
  AssistantDataSourceResolver,
  AssistantSubjectContext,
} from '@domain/ports/AssistantDataSourceRegistry';

/**
 * ai-assistant-multiagent — fuente `os.abiertas`.
 *
 * Órdenes de servicio / tareas ABIERTAS del cliente. Es lo que alimenta el "¿cuándo viene el
 * técnico?".
 *
 * ⚠️ **El `title` de la tarea NO se incluye, a propósito.** En un ISP los títulos suelen traer
 * el nombre del titular ("Instalación Juan Pérez", "Reclamo Sra. González") y a veces el
 * domicilio. Sería una fuga de identidad por la puerta de atrás — de las que `forbiddenValues`
 * ataja sólo si el nombre coincide EXACTO, y no ataja si el título dice "la suegra de Pérez".
 * Al modelo le alcanza con CUÁNTAS hay y CUÁNDO es la próxima; el detalle lo da un humano.
 */
export class OsAbiertasResolver implements AssistantDataSourceResolver {
  readonly key = 'os.abiertas';

  constructor(private readonly listTasks: ListTasks) {}

  async resolve(ctx: AssistantSubjectContext): Promise<Record<string, unknown>> {
    if (!ctx.clientId) return { disponible: false, motivo: 'cliente_no_identificado' };

    const tasks = await this.listTasks.execute({ customerId: ctx.clientId, status: 'open' });

    // La próxima visita = la fecha de inicio futura más cercana. Las tareas sin fecha
    // agendada existen (abiertas pero sin turno) y NO deben contarse como "próxima visita":
    // decir una fecha que no está confirmada es peor que decir que todavía no hay fecha.
    const upcoming = tasks
      .map((t) => t.startDate)
      .filter((d): d is string => typeof d === 'string' && d.length > 0)
      .sort();

    return {
      disponible: true,
      cantidad: tasks.length,
      proximaFecha: upcoming[0] ?? null,
      // Distinguir "no tenés nada agendado" de "tenés algo abierto pero sin turno todavía"
      // evita que el bot responda "no tenés visitas" a alguien que sí tiene un reclamo vivo.
      hayAbiertasSinFecha: tasks.length > upcoming.length,
    };
  }
}
