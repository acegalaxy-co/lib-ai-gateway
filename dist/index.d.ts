type Tier = "fast" | "balanced" | "deep";
type DenyReason = "L1_provider_unavailable" | "L2_authz" | "L3_budget_exhausted" | "L4_circuit_open" | "L5_audit_fatal";
interface ChatMessage {
    role: "user" | "assistant" | "system";
    content: string | Array<Record<string, unknown>>;
}
interface ToolSpec {
    name: string;
    description?: string;
    input_schema?: Record<string, unknown>;
}
interface ModelOverride {
    provider: "anthropic-api" | "openai-compat" | string;
    model: string;
    baseUrl?: string;
    apiKeyEnv?: string;
}
interface AICallRequest {
    skill: string;
    tier: Tier;
    prompt?: string;
    messages?: ChatMessage[];
    systemPrompt?: string;
    tools?: ToolSpec[];
    onDelta?: (text: string) => void;
    modelOverride?: ModelOverride;
    schema?: Record<string, unknown> | null;
    maxOutputTokens?: number;
    metadata?: Record<string, unknown>;
    mcpConfigPath?: string;
    systemPromptCacheable?: boolean;
}
interface AICallResponse {
    outcome: "allow" | "deny";
    denyReason: DenyReason | null;
    text: string | null;
    schemaJson: unknown | null;
    provider: string | null;
    model: string | null;
    tokensIn: number;
    tokensOut: number;
    latencyMs: number;
    needsToolExecution?: boolean;
    response?: Record<string, unknown> | null;
}
declare function dispatchCall(req: AICallRequest): Promise<AICallResponse>;
interface AIEmbedRequest {
    skill: string;
    tier: Tier;
    inputs: string[];
    metadata?: Record<string, unknown>;
}
interface AIEmbedResponse {
    outcome: "allow" | "deny";
    denyReason: DenyReason | null;
    vectors: number[][] | null;
    provider: string | null;
    model: string | null;
    tokensIn: number;
    latencyMs: number;
}
declare function dispatchEmbed(req: AIEmbedRequest): Promise<AIEmbedResponse>;
declare const _default: {
    dispatchCall: typeof dispatchCall;
    dispatchEmbed: typeof dispatchEmbed;
    isLocalEndpoint: any;
    resolveEnv: any;
};
export = _default;
//# sourceMappingURL=index.d.ts.map