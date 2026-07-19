interface ProxyOverrideInput {
    provider?: string;
    model: string;
    baseUrl?: string;
    apiKeyEnv?: string;
}
interface ProxyOverrideResult {
    model: string;
    baseUrl?: string;
    apiKeyEnv?: string;
}
interface FamilyMatch {
    provider?: string;
    providerPrefix?: string;
    modelPrefix?: string;
}
interface FamilyConfig {
    prefix: string;
    originalHosts: string[];
    match: FamilyMatch;
    baseUrlEnv: string[];
    proxyEnableEnv: string | null;
    switchTokenOnProxyHost: boolean;
}
interface ProxyConfig {
    proxy: {
        baseUrlEnv: string;
        tokenEnv: string;
        hostPattern: string;
    };
    families: Record<string, FamilyConfig>;
    localDetect: {
        baseUrlEnv: string;
        forceLocalEnv: string;
    };
}
declare function _resetConfigCache(): void;
declare function _loadProxyConfig(): ProxyConfig;
declare function applyProxyOverride(input: ProxyOverrideInput): ProxyOverrideResult;
declare const _default: {
    applyProxyOverride: typeof applyProxyOverride;
    _resetConfigCache: typeof _resetConfigCache;
    _loadProxyConfig: typeof _loadProxyConfig;
};
export = _default;
//# sourceMappingURL=index.d.ts.map