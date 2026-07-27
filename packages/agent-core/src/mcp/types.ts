/** Transport-agnostic MCP protocol types used outside the SDK adapter. */

export interface MCPAnnotations {
  audience?: Array<'user' | 'assistant'>;
  priority?: number;
  lastModified?: string;
}

export interface MCPIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: 'light' | 'dark';
}

export interface MCPImplementation {
  name: string;
  version: string;
  title?: string;
  websiteUrl?: string;
  icons?: MCPIcon[];
  [key: string]: unknown;
}

export interface MCPServerCapabilities {
  experimental?: Record<string, unknown>;
  logging?: object;
  completions?: object;
  prompts?: { listChanged?: boolean; [key: string]: unknown };
  resources?: { subscribe?: boolean; listChanged?: boolean; [key: string]: unknown };
  tools?: { listChanged?: boolean; [key: string]: unknown };
  tasks?: {
    list?: object;
    cancel?: object;
    requests?: { tools?: { call?: object } };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface MCPServerInfo {
  serverInfo?: MCPImplementation;
  capabilities: MCPServerCapabilities;
  instructions?: string;
}

export interface MCPRoot {
  uri: string;
  name?: string;
  _meta?: Record<string, unknown>;
}

export type MCPLoggingLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

export interface MCPLogMessage {
  level: MCPLoggingLevel;
  logger?: string;
  data: unknown;
}

export interface MCPProgressUpdate {
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
}

export interface MCPSamplingMessage {
  role: 'user' | 'assistant';
  content: MCPContentBlock | MCPContentBlock[];
}

export interface MCPModelPreferences {
  hints?: Array<{ name?: string }>;
  costPriority?: number;
  speedPriority?: number;
  intelligencePriority?: number;
}

export interface MCPCreateMessageRequest {
  messages: MCPSamplingMessage[];
  modelPreferences?: MCPModelPreferences;
  systemPrompt?: string;
  includeContext?: 'none' | 'thisServer' | 'allServers';
  temperature?: number;
  maxTokens: number;
  stopSequences?: string[];
  metadata?: object;
  tools?: MCPToolDefinition[];
  toolChoice?: { mode?: 'required' | 'auto' | 'none' };
  task?: { ttl?: number };
}

export interface MCPCreateMessageResult {
  role: 'assistant';
  content: MCPContentBlock;
  model: string;
  stopReason?: 'endTurn' | 'stopSequence' | 'maxTokens' | 'toolUse';
}

export interface MCPHostRequestContext {
  readonly serverName: string;
  readonly requestId: string | number;
  readonly signal: AbortSignal;
}

export interface MCPHostNotificationContext {
  readonly serverName: string;
}

export interface MCPElicitationRequest {
  mode?: 'form';
  message: string;
  requestedSchema: Record<string, unknown>;
  task?: { ttl?: number };
}

export interface MCPElicitationUrlRequest {
  mode: 'url';
  message: string;
  elicitationId: string;
  url: string;
  task?: { ttl?: number };
}

export type MCPElicitationRequestUnion = MCPElicitationRequest | MCPElicitationUrlRequest;

export interface MCPElicitationResult {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, string | number | boolean | string[]>;
}

export interface MCPHost {
  readonly roots?: {
    list: () => MCPRoot[] | Promise<MCPRoot[]>;
    onChanged?: (listener: () => void) => () => void;
  };
  readonly sampling?: {
    createMessage: (
      request: MCPCreateMessageRequest,
      context: MCPHostRequestContext,
    ) => MCPCreateMessageResult | Promise<MCPCreateMessageResult>;
    supportsTools?: boolean;
  };
  readonly elicitation?: {
    create: (
      request: MCPElicitationRequestUnion,
      context: MCPHostRequestContext,
    ) => MCPElicitationResult | Promise<MCPElicitationResult>;
    complete?: (
      elicitationId: string,
      context: MCPHostNotificationContext,
    ) => void | Promise<void>;
    supportsUrl?: boolean;
  };
}

/**
 * Inline resource contents nested under an EmbeddedResource block.
 * Exactly one of `text` or `blob` is populated, per the MCP schema's
 * `TextResourceContents | BlobResourceContents` union.
 */
export interface MCPEmbeddedResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * A content block as returned by an MCP tool call (`tools/call`).
 *
 * This is a structural subset of the MCP protocol `ContentBlock` union,
 * covering the shapes that {@link convertMCPContentBlock} knows how to convert
 * into kosong `ContentPart`s. Additional fields are ignored.
 */
export interface MCPContentBlock {
  // Known values: 'text' | 'image' | 'audio' | 'resource' | 'resource_link'.
  // Declared as `string` to also accept future MCP content types without a
  // type assertion.
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  title?: string;
  description?: string;
  size?: number;
  annotations?: MCPAnnotations;
  icons?: MCPIcon[];
  _meta?: Record<string, unknown>;
  // EmbeddedResource carries its payload nested under `resource`, per the
  // MCP spec — never as top-level `data`/`mimeType`.
  resource?: MCPEmbeddedResourceContents;
  [key: string]: unknown;
}

/**
 * Result of a single MCP tool invocation.
 *
 * Matches the shape returned by the MCP protocol's `tools/call` method.
 */
export interface MCPToolResult {
  content: MCPContentBlock[];
  isError: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/**
 * An MCP tool definition as returned by an MCP server's `tools/list` method.
 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
  title?: string;
  icons?: MCPIcon[];
  annotations?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  execution?: MCPToolExecution;
  _meta?: Record<string, unknown>;
}

export interface MCPToolExecution extends Record<string, unknown> {
  taskSupport?: 'required' | 'optional' | 'forbidden';
}

export type MCPTaskStatus =
  | 'working'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface MCPTask {
  taskId: string;
  status: MCPTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number | null;
  pollInterval?: number;
  _meta?: Record<string, unknown>;
}

export interface MCPTaskCreationOptions extends Record<string, unknown> {
  ttl?: number;
  pollInterval?: number;
}

export type MCPTaskStatusListener = (task: MCPTask) => void;

export interface MCPResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: MCPAnnotations;
  icons?: MCPIcon[];
  _meta?: Record<string, unknown>;
}

export interface MCPResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: MCPAnnotations;
  icons?: MCPIcon[];
  _meta?: Record<string, unknown>;
}

export interface MCPResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
}

export interface MCPReadResourceResult {
  contents: MCPResourceContents[];
  _meta?: Record<string, unknown>;
}

export interface MCPPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface MCPPromptDefinition {
  name: string;
  title?: string;
  description?: string;
  arguments?: MCPPromptArgument[];
  icons?: MCPIcon[];
  _meta?: Record<string, unknown>;
}

export interface MCPPromptMessage {
  role: 'user' | 'assistant';
  content: MCPContentBlock;
}

export interface MCPGetPromptResult {
  description?: string;
  messages: MCPPromptMessage[];
  _meta?: Record<string, unknown>;
}

export type MCPCompletionReference =
  | { type: 'ref/prompt'; name: string }
  | { type: 'ref/resource'; uri: string };

export interface MCPCompletionArgument {
  name: string;
  value: string;
}

export interface MCPCompletionResult {
  values: string[];
  total?: number;
  hasMore?: boolean;
}

export type MCPListKind = 'tools' | 'resources' | 'prompts';
export type MCPListChangedListener = (kind: MCPListKind) => void;
export type MCPResourceUpdatedListener = (uri: string) => void;
export type MCPLogListener = (message: MCPLogMessage) => void;
export type MCPProgressListener = (update: MCPProgressUpdate) => void;

/**
 * Minimal MCP client interface consumed by {@link McpConnectionManager} and
 * {@link ToolManager}.
 *
 * This is a transport-agnostic seam: implementations can wrap
 * `@modelcontextprotocol/sdk`, a bespoke stdio client, an HTTP SSE client,
 * or a mock for testing. Keeping the surface small lets tests inject fakes
 * without pulling in the full SDK type graph.
 */
export interface MCPToolClient {
  listTools(signal?: AbortSignal): Promise<MCPToolDefinition[]>;
  /**
   * Invoke a tool by name with the given JSON arguments.
   *
   * `signal`, when provided, is forwarded to the underlying transport so an
   * abort from the loop (e.g. user cancellation) propagates all the way to
   * the server instead of leaving the request running in the background.
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPToolResult>;
}

export interface MCPClient extends MCPToolClient {
  getServerInfo(): MCPServerInfo;
  listResources(signal?: AbortSignal): Promise<MCPResource[]>;
  listResourceTemplates(signal?: AbortSignal): Promise<MCPResourceTemplate[]>;
  readResource(uri: string, signal?: AbortSignal): Promise<MCPReadResourceResult>;
  subscribeResource(uri: string, signal?: AbortSignal): Promise<void>;
  unsubscribeResource(uri: string, signal?: AbortSignal): Promise<void>;
  listPrompts(signal?: AbortSignal): Promise<MCPPromptDefinition[]>;
  getPrompt(
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<MCPGetPromptResult>;
  complete(
    reference: MCPCompletionReference,
    argument: MCPCompletionArgument,
    context?: { arguments?: Record<string, string> },
    signal?: AbortSignal,
  ): Promise<MCPCompletionResult>;
  onListChanged(listener: MCPListChangedListener): () => void;
  onResourceUpdated(listener: MCPResourceUpdatedListener): () => void;
  onLogMessage(listener: MCPLogListener): () => void;
  onProgress(listener: MCPProgressListener): () => void;
  onTaskStatus(listener: MCPTaskStatusListener): () => void;
  setLoggingLevel(level: MCPLoggingLevel, signal?: AbortSignal): Promise<void>;
  sendRootsListChanged(): Promise<void>;
  callToolAsTask(
    name: string,
    args: Record<string, unknown>,
    task?: MCPTaskCreationOptions,
    signal?: AbortSignal,
  ): Promise<MCPToolResult>;
  listTasks(signal?: AbortSignal): Promise<MCPTask[]>;
  getTask(taskId: string, signal?: AbortSignal): Promise<MCPTask>;
  getTaskResult(taskId: string, signal?: AbortSignal): Promise<MCPToolResult>;
  cancelTask(taskId: string, signal?: AbortSignal): Promise<MCPTask>;
}

/**
 * Validate the `inputSchema` field of an MCP tool definition. MCP advertises
 * input schemas as JSON Schema objects; reject anything that is not a plain
 * object so the validator compiler downstream never sees `null` or a
 * primitive.
 */
export function assertMcpInputSchema(
  toolName: string,
  inputSchema: unknown,
): Record<string, unknown> {
  if (typeof inputSchema === 'object' && inputSchema !== null && !Array.isArray(inputSchema)) {
    return inputSchema as Record<string, unknown>;
  }
  throw new Error(`Invalid inputSchema for MCP tool "${toolName}": schema must be a JSON object`);
}
