/* ---- OpenAI / Anthropic 协议形状（只声明用到的字段） ---- */

export interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface OpenAIMessage {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIChatRequest {
  model?: string;
  messages?: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  metadata?: Record<string, unknown>;
}

export interface AnthropicContentBlock {
  type?: string;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  source?: Record<string, unknown>;
}

export interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

export interface AnthropicRequest {
  model?: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}
