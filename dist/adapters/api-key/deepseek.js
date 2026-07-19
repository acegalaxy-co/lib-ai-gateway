"use strict";
// ai-gateway/adapters/api-key/deepseek.ts
// Dedicated DeepSeek adapter (option 1 from project_deepseek_adapter_todo).
//
// Previously DeepSeek ran through the generic OpenAICompatAdapter (provider
// "openai-compat", shared with Gemini/GPT/Mistral/Grok). This adapter gives
// DeepSeek its own provider id ("deepseek-api") for audit/cost clarity and a
// place to hang DeepSeek-specific tuning (response_format json_object when a
// schema is requested) without touching the generic multi-provider adapter.
//
// Request/response shape + reasoning_content handling + streaming are
// IDENTICAL to openai-compat (DeepSeek IS an OpenAI-compatible Chat
// Completions API) — reused via named exports from openai-compat.ts rather
// than duplicated.
const { IAIAdapter } = require("../adapter-interface");
const { _maxTokensField, _convertMessages, _convertTools, _consumeStream, REQUEST_TIMEOUT_MS, } = require("./openai-compat");
class DeepSeekAdapter extends IAIAdapter {
    get provider() {
        return "deepseek-api";
    }
    async complete(req) {
        const baseUrl = req.baseUrl;
        const apiKeyEnv = req.apiKeyEnv;
        if (!baseUrl)
            throw new Error("deepseek-api: missing baseUrl in policy binding");
        if (!apiKeyEnv)
            throw new Error("deepseek-api: missing apiKeyEnv in policy binding");
        const apiKey = process.env[apiKeyEnv];
        if (!apiKey)
            throw new Error(`deepseek-api: ${apiKeyEnv} not set`);
        const isChatMode = Array.isArray(req.messages);
        const openAIMessages = isChatMode
            ? _convertMessages(req.messages, req.systemPrompt)
            : (() => {
                const arr = [];
                if (req.systemPrompt)
                    arr.push({ role: "system", content: req.systemPrompt });
                arr.push({ role: "user", content: String(req.prompt || "") });
                return arr;
            })();
        const body = {
            model: req.model,
            [_maxTokensField(req.model)]: req.maxOutputTokens,
            messages: openAIMessages,
        };
        if (req.tools && req.tools.length > 0) {
            body.tools = _convertTools(req.tools);
        }
        // DeepSeek tuning: caller wants a schema back → force strict JSON object
        // mode so the model doesn't wrap the answer in prose/markdown fences.
        if (req.schema) {
            body.response_format = { type: "json_object" };
        }
        if (req.onDelta) {
            body.stream = true;
            body.stream_options = { include_usage: true };
        }
        const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`deepseek-api ${req.model} ${resp.status}: ${errText.slice(0, 200)}`);
        }
        // Streaming path — identical wire format to openai-compat.
        if (req.onDelta) {
            return await _consumeStream(resp, req);
        }
        // Non-streaming path. Some proxies (e.g. 9router) append an SSE terminator
        // (`data: [DONE]`) after the JSON body even for non-stream requests, which
        // breaks resp.json(). Read as text and parse only the leading JSON object.
        const raw = await resp.text();
        let data;
        try {
            data = JSON.parse(raw);
        }
        catch (_e) {
            const cleaned = raw.replace(/\s*data:\s*\[DONE\]\s*$/i, "").trim();
            data = JSON.parse(cleaned);
        }
        const choice = data?.choices?.[0];
        const usage = {
            input_tokens: data?.usage?.prompt_tokens || 0,
            output_tokens: data?.usage?.completion_tokens || 0,
        };
        // Tool_calls present → return assistant turn in Anthropic shape.
        if (choice?.finish_reason === "tool_calls" || choice?.message?.tool_calls?.length > 0) {
            const content = [];
            if (choice.message.reasoning_content) {
                content.push({ type: "reasoning_content", text: choice.message.reasoning_content });
            }
            if (choice.message.content) {
                content.push({ type: "text", text: choice.message.content });
            }
            for (const tc of choice.message.tool_calls || []) {
                content.push({
                    type: "tool_use",
                    id: tc.id,
                    name: tc.function.name,
                    input: (() => { try {
                        return JSON.parse(tc.function.arguments || "{}");
                    }
                    catch {
                        return {};
                    } })(),
                });
            }
            return {
                text: null,
                schemaJson: null,
                tokensIn: usage.input_tokens,
                tokensOut: usage.output_tokens,
                needsToolExecution: true,
                response: { content, stop_reason: "tool_use" },
            };
        }
        // reasoning_content (DeepSeek thinking mode) is never surfaced as `text` —
        // only the final answer content is. Callers needing the reasoning trace
        // get it via the chat-mode `response.content` path above (tool_calls) or
        // can inspect assistant message content blocks in later rounds.
        const text = choice?.message?.content ?? null;
        let schemaJson = null;
        if (req.schema && text) {
            try {
                schemaJson = JSON.parse(text);
            }
            catch (_e) {
                schemaJson = null;
            }
        }
        return {
            text,
            schemaJson,
            tokensIn: usage.input_tokens,
            tokensOut: usage.output_tokens,
            needsToolExecution: false,
            response: null,
        };
    }
    estimateTokens(prompt) {
        return Math.ceil((prompt || "").length / 3.5);
    }
}
module.exports = { DeepSeekAdapter };
//# sourceMappingURL=deepseek.js.map