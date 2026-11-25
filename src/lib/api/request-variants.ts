/**
 * Тело запроса к DeepSeek (OpenAI-совместимый формат) и его упрощённые варианты.
 *
 * Модуль намеренно без зависимостей: логику легко прогнать отдельным тестом.
 */

export type RequestBody = Record<string, unknown>;

export interface RequestVariant {
  /** Человекочитаемое описание варианта — попадает в лог и текст ошибки. */
  label: string;
  body: RequestBody;
}

function toolList(body: RequestBody): Array<{ type?: string }> | undefined {
  return Array.isArray(body.tools) ? (body.tools as Array<{ type?: string }>) : undefined;
}

/** Серверные инструменты (`deepseek_web_search`, …) в отличие от function-tools. */
function isServerTool(tool: { type?: string }): boolean {
  return typeof tool?.type === 'string' && tool.type !== 'function';
}

function withoutServerTools(body: RequestBody): RequestBody {
  const next = { ...body };
  const functions = toolList(body)?.filter((tool) => !isServerTool(tool)) ?? [];
  if (functions.length > 0) next.tools = functions;
  else delete next.tools;
  return next;
}

function withoutThinking(body: RequestBody): RequestBody {
  const next = { ...body };
  delete next.thinking;
  delete next.reasoning_effort;
  return next;
}

/**
 * Варианты тела запроса от «полного» к упрощённому: сначала убираем серверные
 * веб-инструменты, затем режим размышлений. Нужны на случай HTTP 400, когда
 * выбранная модель не принимает часть параметров.
 */
export function requestVariants(body: RequestBody): RequestVariant[] {
  const variants: RequestVariant[] = [{ label: 'полный запрос', body }];
  const hasServerTools = Boolean(toolList(body)?.some(isServerTool));
  const hasThinking = 'thinking' in body || 'reasoning_effort' in body;

  if (hasServerTools) {
    const reduced = withoutServerTools(body);
    variants.push({ label: 'без веб-инструментов', body: reduced });
    if (hasThinking) {
      variants.push({ label: 'без веб-инструментов и размышлений', body: withoutThinking(reduced) });
    }
  } else if (hasThinking) {
    variants.push({ label: 'без размышлений', body: withoutThinking(body) });
  }

  return variants;
}
