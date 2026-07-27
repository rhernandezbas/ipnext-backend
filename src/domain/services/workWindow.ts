import type { TimeWindow } from '../entities/team-location-point';

/**
 * workWindow — deriva la ventana REAL de trabajo de una orden a partir de su histórico
 * de estados (`GET /serviceorders/{id}/history`). PURO.
 *
 * ## Por qué NO se usa `dataAgendamento`
 *
 * Una orden puede agendarse un día y ejecutarse otro. La OS 4995 rebotó NUEVE días entre
 * dos cuadrillas (22-06 → 02-07) antes de ejecutarse. Auditar contra el día agendado
 * produce conclusiones sobre un día equivocado — y una conclusión sobre el día equivocado
 * es peor que ninguna conclusión.
 *
 * ## Por qué se modelan CICLOS y no una sola ventana (review adversarial, hallazgos 1.1/1.2)
 *
 * La versión anterior tomaba `[primer evento de ejecución de TODO el histórico, primer
 * cierre posterior]`. Eso rompía de tres formas:
 *
 *  1. **Reejecución**: con dos ciclos (uno abortado y la visita real días después), la
 *     ventana quedaba en el PRIMERO → se auditaba el día equivocado.
 *  2. **Rebote**: un `DESLOCAMENTO` suelto de un despacho previo estiraba la ventana a
 *     9 días → cualquier punto cerca del domicilio absolvía automáticamente, y
 *     `executionDurationMinutes` daba ~13.000 min, con lo que la 4995 —el caso testigo
 *     del pre-filtro— dejaba de detectarse.
 *  3. **Sin cierre**: la ventana se cerraba en el último estado de ejecución, que es
 *     justo cuando el técnico EMPIEZA. Se auditaba el tramo de viaje y se condenaba por
 *     estar en la ruta.
 *
 * Ahora el histórico se agrupa en ciclos `[ejecución … cierre]`, cada uno con SU cuadrilla
 * (la orden puede reasignarse entre ciclos), y un ciclo sin cierre queda marcado como
 * NO cerrado para que el consumidor degrade a `NO_CONCLUYENTE` en vez de condenar.
 */

export interface SoStatusEvent {
  at: Date;
  /** `statusOS.descricao` de IClass (viene en portugués). */
  status: string;
  /**
   * `equipeDTO.login` del evento. La orden puede reasignarse, así que la cuadrilla que
   * EJECUTÓ un ciclo no es necesariamente la que figura asignada hoy. Auditar el rastro
   * de la cuadrilla equivocada acusa a una persona que ni tenía la orden.
   */
  teamLogin?: string | null;
}

/** Un tramo de ejecución en campo, de su inicio a su cierre. */
export interface ExecutionCycle {
  from: Date;
  /** Instante de cierre. `null` si el ciclo nunca cerró. */
  to: Date | null;
  /** `false` cuando no hay evento de cierre: la ventana NO puede acotarse por arriba. */
  closed: boolean;
  /** Cuadrilla que ejecutó ESTE ciclo. */
  teamLogin: string | null;
}

export interface WorkWindowOptions {
  /**
   * Margen a cada lado, en minutos. Existe porque los breadcrumbs llegan cada 5-10 min:
   * una ventana cruda de 2 minutos puede no contener NINGÚN punto y producir un
   * `NO_CONCLUYENTE` espurio.
   */
  marginMinutes?: number;
}

/** Margen por defecto de la ventana. Propio de este servicio, no de la evaluación. */
export const DEFAULT_WINDOW_MARGIN_MINUTES = 15;

/** Estados en que la cuadrilla está efectivamente trabajando la orden. */
const EXECUTION_STATUSES = new Set(['DESLOCAMENTO', 'ANDAMENTO']);

/**
 * Estados que cierran la ejecución en campo.
 * `ENCERRADO` se incluye: aparece en el histórico real y sin él un ciclo cerrado sólo
 * con `ENCERRADO` quedaba sin cota superior.
 */
const CLOSING_STATUSES = new Set(['FECHADA', 'ENCERRADO']);

/**
 * Estados que devuelven la orden al circuito de despacho. Abandonan el ciclo en curso
 * SIN cerrarlo: el técnico dejó de trabajarla y lo que venga después es otro intento.
 *
 * Sin esta regla, un `DESLOCAMENTO` suelto de un despacho previo se fusiona con la
 * ejecución real de días después y produce una ventana de 9 días — el caso exacto de la
 * OS 4995, que además anulaba el pre-filtro de cierres imposibles.
 */
const DISPATCH_RESET_STATUSES = new Set([
  'AGENDADA',
  'DESPACHADA',
  'DESPACHADA EMPREITEIRA',
  'ASSOCIADA EQUIPE',
  'EM ANALISE',
  'PRE ABERTA',
  'ABERTA',
]);

/**
 * Normaliza el nombre del estado: mayúsculas y sin acentos. IClass emite variantes
 * (`APROVAÇÃO`, `Fechada`) y un match literal se pierde casos silenciosamente.
 *
 * El rango se escribe con escapes (`̀-ͯ`) y no con los combining marks
 * literales: literales son invisibles en cualquier editor y un normalizador de encoding
 * puede romperlos sin que nadie lo note.
 */
const COMBINING_MARKS = /[̀-ͯ]/g;

const normalize = (status: string): string =>
  status.normalize('NFD').replace(COMBINING_MARKS, '').trim().toUpperCase();

/**
 * Agrupa el histórico en ciclos de ejecución.
 *
 * Un ciclo abre en el primer estado de ejecución que no pertenece a un ciclo abierto, y
 * cierra en el primer estado de cierre posterior. Los estados administrativos
 * (`AGENDADA`, `DESPACHADA`, `EM ANALISE`, `APROVAÇÃO`…) no abren ni cierran ciclos.
 */
export function computeExecutionCycles(history: SoStatusEvent[]): ExecutionCycle[] {
  // IClass devuelve el histórico DESORDENADO (verificado en la OS 4995), así que
  // ordenar acá no es defensivo de más: es necesario.
  const sorted = [...history].sort((a, b) => a.at.getTime() - b.at.getTime());

  const cycles: ExecutionCycle[] = [];
  let open: ExecutionCycle | null = null;

  for (const event of sorted) {
    const status = normalize(event.status);

    if (EXECUTION_STATUSES.has(status)) {
      if (!open) {
        open = { from: event.at, to: null, closed: false, teamLogin: event.teamLogin ?? null };
        cycles.push(open);
      } else if (open.teamLogin === null && event.teamLogin) {
        // Si el primer evento del ciclo no traía cuadrilla, se toma la del siguiente.
        open.teamLogin = event.teamLogin;
      }
      continue;
    }

    if (CLOSING_STATUSES.has(status) && open) {
      open.to = event.at;
      open.closed = true;
      open = null;
      continue;
    }

    // La orden volvió a despacho: el ciclo en curso queda ABANDONADO (sin cierre), y lo
    // que venga después abre un ciclo nuevo. Nunca se fusionan dos intentos distintos.
    if (DISPATCH_RESET_STATUSES.has(status) && open) {
      // R6 de la re-review: abandonar SIEMPRE partía ciclos legítimos. Un re-despacho a
      // la MISMA cuadrilla con la orden en curso (DESLOCAMENTO → DESPACHADA → ANDAMENTO
      // → FECHADA) es un evento normal en IClass, y partirlo recortaba la ventana
      // dejando afuera el viaje y la llegada — justo el tramo que probaría EN_SITIO.
      // El ciclo se abandona sólo si el despacho es para OTRA cuadrilla, o si no se
      // puede saber para quién.
      const sameTeam = event.teamLogin != null && event.teamLogin === open.teamLogin;
      if (!sameTeam) open = null;
    }
  }

  return cycles;
}

/**
 * Ventana de trabajo del ciclo RELEVANTE, o `null` si no hay ninguno utilizable.
 *
 * El ciclo relevante es el ÚLTIMO cerrado: es el que efectivamente resolvió la orden.
 * Un ciclo sin cierre NO produce ventana — su cota superior es desconocida y truncarla
 * en el último estado de ejecución audita el tramo de viaje y condena por estar en ruta.
 */
export function computeWorkWindow(
  history: SoStatusEvent[],
  options: WorkWindowOptions = {},
): TimeWindow | null {
  const cycle = relevantCycle(history);
  if (!cycle || !cycle.closed || !cycle.to) return null;

  const marginMs = (options.marginMinutes ?? DEFAULT_WINDOW_MARGIN_MINUTES) * 60_000;
  return {
    from: new Date(cycle.from.getTime() - marginMs),
    to: new Date(cycle.to.getTime() + marginMs),
  };
}

/**
 * El ciclo que la auditoría debe mirar: el último CERRADO. Si no hay ninguno cerrado,
 * devuelve el último abierto (para que el consumidor pueda explicar POR QUÉ no se puede
 * auditar, en vez de decir sólo "no hay ventana").
 */
export function relevantCycle(history: SoStatusEvent[]): ExecutionCycle | null {
  const cycles = computeExecutionCycles(history);
  if (cycles.length === 0) return null;

  for (let i = cycles.length - 1; i >= 0; i--) {
    if (cycles[i].closed) return cycles[i];
  }
  return cycles[cycles.length - 1];
}

/**
 * Duración de la ejecución en campo del ciclo relevante, en minutos, SIN margen.
 *
 * Es el pre-filtro barato: no necesita GPS y detecta lo físicamente imposible. La OS 4995
 * registró viaje + visita + cierre en 2 min 16 s, con un DESLOCAMENTO de 11 segundos.
 *
 * Devuelve `null` si no hay ciclo CERRADO: una orden en curso no tiene duración medible,
 * y contarla produciría un falso positivo sistemático contra el técnico que está
 * trabajando en este momento.
 *
 * Marca CANDIDATOS a revisar, nunca incumplimientos.
 */
export function executionDurationMinutes(history: SoStatusEvent[]): number | null {
  const cycle = relevantCycle(history);
  if (!cycle || !cycle.closed || !cycle.to) return null;
  return (cycle.to.getTime() - cycle.from.getTime()) / 60_000;
}
