/** Shared types for the chat UI and the SSE contract between frontend and backend. */

export type ChatRole = 'user' | 'assistant';

/** Lifecycle of a single step shown in the Execution Details panel. */
export type StageStatus = 'running' | 'done' | 'failed';

/** Stable identifiers for the progress stages the backend can emit. */
export type StageId =
  | 'request_received'
  | 'tool_discovery'
  | 'tool_selection'
  | 'mcp_execution'
  | 'mcp_response'
  | 'response_processing'
  | 'llm_reasoning'
  | 'completed';

/** One row in the Execution Details panel. */
export interface ExecutionStage {
  /** Unique per assistant turn; lets later events update an earlier row. */
  key: string;
  id: StageId;
  label: string;
  status: StageStatus;
  /** Real measured duration, populated when the stage finishes. */
  durationMs?: number;
  /** Discovered MCP tool name, when the stage concerns a tool. */
  tool?: string;
  /** Record count, only when it could be determined reliably. */
  recordCount?: number;
  /** Sanitised failure reason. Never contains credentials or raw payloads. */
  error?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** Execution history is retained per assistant message. */
  stages?: ExecutionStage[];
  /** Set when the turn ended in a user-facing error. */
  error?: string;
  /** True while the assistant message is still streaming. */
  pending?: boolean;
}

/* ------------------------------------------------------------------ */
/* SSE event contract (this application's own contract, not MCP's)     */
/* ------------------------------------------------------------------ */

export type ServerEvent =
  | { type: 'status'; stage: StageId; key: string; message: string; status: StageStatus }
  | { type: 'tool_selected'; key: string; tool: string; message: string }
  | { type: 'tool_started'; key: string; tool: string; message: string }
  | {
      type: 'tool_completed';
      key: string;
      tool: string;
      durationMs: number;
      success: true;
      recordCount?: number;
      message: string;
    }
  | { type: 'tool_failed'; key: string; tool: string; durationMs: number; success: false; message: string }
  | { type: 'answer_delta'; text: string }
  /**
   * Clears text already streamed for the current turn. Gemini occasionally
   * emits a short preamble before deciding to call a tool; that preamble is
   * not the answer, so it is withdrawn rather than left on screen.
   */
  | { type: 'answer_reset' }
  | { type: 'completed'; message: string }
  | { type: 'error'; message: string };

/** Request body accepted by POST /api/chat. */
export interface ChatRequestBody {
  message: string;
  /** Prior turns of the current browser session. Not persisted server-side. */
  history?: Array<{ role: ChatRole; content: string }>;
}

/** Response shape of GET /api/health. Deliberately free of secrets. */
export interface HealthResponse {
  status: 'connected' | 'configuration_required' | 'connection_failed';
  checks: {
    gemini: { configured: boolean; model: string | null; detail: string };
    salesforceOAuth: { authorized: boolean; detail: string };
    salesforceMcp: {
      configured: boolean;
      reachable: boolean;
      toolCount: number | null;
      detail: string;
      /** Per-endpoint outcome, so one unreachable custom server is visible. */
      endpoints?: { id: string; connected: boolean; toolCount: number; error?: string }[];
    };
  };
}
