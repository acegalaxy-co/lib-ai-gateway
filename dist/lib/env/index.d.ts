/** True when the current process routes LLM calls through the local 9router proxy. */
declare function isLocalEndpoint(): boolean;
/** Runtime env label matching the Notion `Env` select column ("Local" | "Prod"). */
declare function resolveEnv(): "Local" | "Prod";
declare const _default: {
    isLocalEndpoint: typeof isLocalEndpoint;
    resolveEnv: typeof resolveEnv;
};
export = _default;
//# sourceMappingURL=index.d.ts.map