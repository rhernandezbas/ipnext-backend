import type { TemplateAdminPort, CreateTemplateInput as ProviderCreateTemplateInput, TemplateButton } from '@domain/ports/TemplateMessagingPort';
import type { CreateTemplateInput, TemplateDetailDto } from '@application/dto/messaging-templates.dto';
import { toTemplateDetailDto, isTemplateCategory } from '@application/dto/messaging-templates.dto';
import { InvalidTemplateInputError } from '@domain/errors/messaging-bulk';

/** whatsapp-template-buttons (design §2/#3) — topes de Meta, no verificados offline (ASUNCIÓN). */
const BUTTON_TITLE_MAX_LENGTH = 25;
const BUTTON_URL_MAX_LENGTH = 2000;

/**
 * whatsapp-template-buttons (design §2/#2/#3) — helper puro module-private:
 * `title` trim no vacío ≤25 chars; `url` parseable como absoluta http/https
 * ≤2000 chars. GOTCHA CRÍTICO (design §Learned): valida con `new URL(raw)`
 * pero devuelve el string RAW (solo trimeado), nunca `.href` — `.href`
 * percent-encodearía placeholders de URL dinámica de Twilio como `{{1}}`.
 *
 * Fix wave (review adversarial): acepta `unknown` y rechaza `null`/no-objeto con
 * el mismo error de validación tipado, para no explotar con un TypeError crudo
 * (500) ante un caller directo del caso de uso. Además valida y almacena la url
 * TRIMEADA: `new URL()` tolera whitespace/newlines de borde, así que validar el
 * raw dejaba pasar un string sucio hacia Twilio.
 */
function assertValidButton(raw: unknown): TemplateButton {
  if (typeof raw !== 'object' || raw === null) {
    throw new InvalidTemplateInputError('button debe ser un objeto { title, url }');
  }
  const button = raw as { title?: unknown; url?: unknown };
  if (typeof button.title !== 'string') {
    throw new InvalidTemplateInputError('button.title es requerido');
  }
  const title = button.title.trim();
  if (!title) {
    throw new InvalidTemplateInputError('button.title no puede estar vacío');
  }
  if (title.length > BUTTON_TITLE_MAX_LENGTH) {
    throw new InvalidTemplateInputError(`button.title excede ${BUTTON_TITLE_MAX_LENGTH} caracteres`);
  }

  if (typeof button.url !== 'string') {
    throw new InvalidTemplateInputError('button.url es requerido');
  }
  const url = button.url.trim();
  if (url.length === 0) {
    throw new InvalidTemplateInputError('button.url es requerido');
  }
  if (url.length > BUTTON_URL_MAX_LENGTH) {
    throw new InvalidTemplateInputError(`button.url excede ${BUTTON_URL_MAX_LENGTH} caracteres`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidTemplateInputError('button.url debe ser una URL absoluta válida');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidTemplateInputError('button.url debe usar http o https');
  }

  return { title, url };
}

/**
 * Change 3 (templates CRUD) — CREAR un template directo a Twilio Content API.
 * Valida la entrada del operador (friendlyName/language/body no vacíos, category
 * ∈ enum si viene), mapea `variables[]` (nombres declarados) al `Record`
 * índice→sample que espera el proveedor, y devuelve un DTO CURADO (nunca el JSON
 * crudo de Twilio). Depende del PORT (`TemplateAdminPort`), jamás de Twilio/axios.
 *
 * Nota: `category` NO viaja al POST de creación (Twilio la fija recién al SUBMIT);
 * acá solo se valida para fallar temprano ante un fat-finger.
 */
export class CreateTemplate {
  constructor(private readonly adminPort: TemplateAdminPort) {}

  async execute(input: CreateTemplateInput): Promise<TemplateDetailDto> {
    const friendlyName = (input.friendlyName ?? '').trim();
    if (!friendlyName) throw new InvalidTemplateInputError('friendlyName es requerido');

    const language = (input.language ?? '').trim();
    if (!language) throw new InvalidTemplateInputError('language es requerido');

    if (!input.body || input.body.trim() === '') {
      throw new InvalidTemplateInputError('body es requerido');
    }

    if (input.category !== undefined && !isTemplateCategory(input.category)) {
      throw new InvalidTemplateInputError(`category inválida: ${input.category}`);
    }

    // `variables[]` (nombres/índices declarados) → Record índice→sample. Twilio
    // usa `variables` como valores de EJEMPLO; sin datos reales usamos el propio
    // nombre como sample (determinístico y suficiente para el preview de Meta).
    const variables: Record<string, string> = {};
    for (const name of input.variables ?? []) {
      variables[name] = name;
    }

    // `!== undefined` (y no `!= null`): un `button: null` explícito es entrada
    // mal formada, no ausencia — entra a `assertValidButton`, que lo rechaza con
    // el error de validación tipado (400) en vez de reventar en un TypeError.
    const button = input.button !== undefined ? assertValidButton(input.button) : undefined;

    const providerInput: ProviderCreateTemplateInput = {
      friendlyName,
      language,
      variables,
      body: input.body,
      button,
    };
    const created = await this.adminPort.createTemplate(providerInput);
    return toTemplateDetailDto(created);
  }
}
