export type ApiRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ApiMessage {
  role: ApiRole;
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface Annotation {
  type?: string;
  url?: string;
  title?: string;
  url_citation?: { url?: string; title?: string; site?: string };
  [key: string]: unknown;
}

export interface BalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance?: string;
  topped_up_balance?: string;
}

export interface BalanceResponse {
  is_available: boolean;
  balance_infos: BalanceInfo[];
}

export interface ChatResponse {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  annotations: Annotation[];
  usage?: Usage;
  /** Заполняется, если запрос удался только в упрощённом виде (после HTTP 400). */
  fallback?: string;
}

export type Effort = 'low' | 'high' | 'max';
