# lib-ai-gateway research — nguồn, phát hiện, hướng cải tiến

Snapshot 2026-09-24. Research đọc git history repo `lib-ai-gateway` (trước đó
`ai-gateway`, đổi tên trong đợt rename `lib-` toàn bộ @acegalaxy libs),
README/package.json hiện tại, code gốc trong ACE Nexus (consumer chính) và
kane-crawler (consumer thứ hai), cùng khảo sát nhanh prior-art LLM
gateway/router. Các fact về consumer/test-count dưới đây là snapshot tại thời
điểm viết — có thể lệch nếu code đổi tiếp sau ngày này.

## Nguồn research

**Nội bộ:**
- Repo GH gốc `acegalaxy-co/ai-gateway` (nay `acegalaxy-co/lib-ai-gateway`,
  GH giữ redirect theo tên cũ), commit đầu `f760e73` "in-repo runtime LLM
  gateway + cut over 4 callsites", tag `v1.0.0` = commit `dc0395bb` (subtree
  split khỏi Nexus, giữ history), tag hiện tại `v1.1.0` (rename package +
  repo 2026-09-24).
- Nexus path gốc: trước khi tách, sống ở `commons/ai-gateway/` (nay đã xoá
  khỏi Nexus, thay bằng dependency git). Trace qua Nexus memory
  `project_ai_gateway_shared_repo.md` (Phase B, 2026-07-19): B1 exports map,
  B1.5 dependency-injection transport cho alert, B2 subtree split + tag
  v1.0.0, B3 cut-over 11 file + xoá `commons/ai-gateway/`, B4 rule/eslint.
- Consumer Nexus: `src/app/llm/client.ts`, `claude-cli.ts`,
  `sensitive-classifier.ts`, `src/app/schedulers/acenexus/model-registry.ts`,
  `feedback-app-processor.ts`, `src/app/services/agent/model-scanner.ts`,
  `src/app/modules/sensitive-audit/detectors/llm.ts`, `src/app/modules/rag/
  lib/embed.ts` + tương ứng test trong `test/llm/`, `test/schedulers/`,
  `test/modules/`. Guardrail: `eslint.config.js` (rule
  `.claude/rules/system-ai-gateway` — cấm import trực tiếp LLM SDK, bắt buộc
  qua `dispatchCall`).
- Consumer kane-crawler: `src/core/claude/gateway-runner.ts`, `cli-text.ts`,
  `smoke-browse.ts`, `src/core/runners/selectRunner.ts`,
  `src/briefings/ai-news.ts`, 4 `src/features/*-search/index.ts` + test
  `test/gateway-runner-fallback.test.ts`, `test/audit-cross-provider.test.ts`.
- Đọc code gốc trong repo hiện tại: `index.ts` (`dispatchCall` 5-layer),
  `authz/engine.ts` + `policies.json`, `rate-limit/budget.ts` +
  `circuit-breaker.ts`, `audit/logger.ts`, `adapters/*.ts`,
  `lib/proxy-override/`, `lib/claude-limit/`.

**Ngoài (không fetch web — không có URL nào đã verify để cite trong phiên
research này; nêu tên nguồn prior-art theo kiến thức chung, không kèm link
bịa):**
- LiteLLM (proxy/SDK thống nhất interface nhiều LLM provider, có budget +
  fallback + rate-limit theo key).
- OpenRouter (routing layer thương mại, chọn model theo giá/latency,
  fallback chain giữa provider).
- Portkey AI Gateway (observability + cache + retry/fallback, virtual keys).

## Đã tham khảo gì

### Bài toán gốc trong Nexus (vì sao tách lib)

Nexus gọi LLM (Claude CLI/API, DeepSeek, Gemini CLI, Codex CLI, OpenAI-compat)
từ nhiều module rải rác (invoice enrich, sensitive-audit, crawler, kane
briefings, report skills...), mỗi nơi tự xử lý auth, model chọn theo skill,
theo dõi quota, phát hiện Claude CLI hit rate-limit (session 5h / weekly 7d)
để bắn alert Telegram, và ghi audit log. Không có 1 điểm kiểm soát trung tâm
→ dễ leak SDK import trực tiếp bỏ qua policy, khó audit chi phí/theo dõi
outage per-provider, và code trùng lặp giữa Nexus và kane-crawler (2 repo
riêng cùng gọi LLM). `ai-gateway` được rút ra làm module runtime chung trong
Nexus trước (`commons/ai-gateway/`), sau đó tách hẳn thành git-dependency
riêng (Phase B, 2026-07) để cả Nexus lẫn kane-crawler consume cùng 1 bản, và
để rule ESLint enforce "mọi LLM call phải qua `dispatchCall`" áp được cả 2
repo.

### Ý tưởng thiết kế chính

- **5-layer default-deny pipeline**: `L1 Adapter` (verify provider + chuẩn
  hoá payload) → `L2 Authz` (ma trận skill→provider/model được phép,
  `policies.json`) → `L3 Budget` (quota token/ngày theo skill, reserve
  trước-call/commit sau-call) → `L4 Circuit breaker` (mở mạch per-provider
  sau N lỗi 5xx liên tiếp) → `L5 Audit` (JSONL append-only: skill, provider,
  model, tokens, latency, outcome). Mọi tầng deny trả `denyReason` rõ ràng
  (`L1_provider_unavailable`...`L5_audit_fatal`), `dispatchCall` không bao
  giờ throw — caller luôn nhận `{outcome, ...}` để xử lý gracefully.
- **Adapter contract thống nhất** (`IAIAdapter`: `provider`, `complete()`,
  `estimateTokens()`) — cho phép thêm provider mới (đã có 6: anthropic-api,
  anthropic-cli, gemini-cli, codex-cli, openai-compat, openai-embeddings) mà
  không đổi core dispatch logic.
- **Model resolution ưu tiên theo lớp** (modelOverride param → env
  `NEXUS_AI_GATEWAY_MODEL_<SKILL>` → env `..._DEFAULT` → policy tier binding)
  — cho phép runtime override khẩn cấp qua env mà không cần deploy lại, giới
  hạn scope override chỉ ở Anthropic (cross-provider cần đổi cả baseUrl +
  apiKeyEnv nên env variable không đủ diễn tả).
- **Config-driven proxy routing** (`config/proxy.json` + `lib/proxy-override/`)
  tách biệt "gateway có 9router proxy hay gọi thẳng API gốc" ra khỏi code —
  chỉ cần đổi JSON + env, không sửa adapter.
- **DI cho alert transport** (`alertClaudeCliLimit(scheduler, skill, kind,
  resetAt, sendAlert)`) — gateway detect Claude CLI rate-limit từ stderr
  nhưng không tự biết cách gửi Telegram; consumer inject hàm gửi. Sửa lại ở
  B1.5 sau khi bản đầu tự resolve module notify bằng path anchor `commons` —
  vỡ khi chạy trong `node_modules`.
- **Audit log path bắt buộc ngoài `node_modules`** — env
  `AI_GATEWAY_AUDIT_LOG_PATH` set ra ngoài để tránh mất log khi `npm install`
  xoá `node_modules`. `AI_GATEWAY_CONFIG_ROOT` cũng nên set tường minh thay
  vì tự walk-up thư mục (không đáng tin khi package nằm sâu trong
  `node_modules`).

### Prior art & vì sao tự viết

So với LiteLLM/OpenRouter/Portkey — các gateway thương mại/OSS lớn này giải
bài toán tương tự (nhiều provider, fallback, quota, observability) nhưng
không phù hợp trực tiếp:
- Cần tích hợp chặt với **CLI subscription flow** (Claude CLI, Gemini CLI,
  Codex CLI chạy qua subprocess, không phải REST key) — các gateway trên chủ
  yếu target API-key flow, không có concept "CLI session limit" để detect và
  alert.
- Policy **skill-scoped** (route theo tên skill nội bộ Nexus/kane-crawler,
  không phải theo user/team) và proxy routing qua **9router** nội bộ (dự án
  riêng của org) — không phải nhu cầu generic mà gateway ngoài hỗ trợ sẵn.
  Thêm layer trung gian dùng thư viện ngoài này sẽ cần lớp adapter riêng dày
  hơn code hiện có.
- Muốn giữ **zero external SDK deps** ở runtime (chỉ `fetch`/`child_process`
  nội bộ) để dễ audit + tránh supply-chain risk khi package này chạy trong
  context có nhiều secret provider.
- Quy mô nhỏ (vài chục skill, 6 provider) — tự viết ~123 test case là chi phí
  chấp nhận được so với học/vận hành 1 gateway ngoài + phải vá behavior CLI
  subscription mà nó không hỗ trợ.

## Hướng cải tiến

**Đã áp dụng:**
- Tách khỏi Nexus thành git-dependency riêng, ship `dist/` committed, tag
  `v1.0.0` (`dc0395bb`, 2026-07-19) — cut-over 11 callsite Nexus + kane-crawler
  qua `require("@acegalaxy/ai-gateway")`, xoá `commons/ai-gateway/`.
- DI transport cho alert (B1.5, bỏ path-anchor `commons` vỡ trong
  `node_modules`).
- Config-driven proxy routing thay vì hardcode host per-family (giảm sửa code
  khi đổi endpoint 9router).
- Rename `@acegalaxy/ai-gateway` → `@acegalaxy/lib-ai-gateway`, repo
  `acegalaxy-co/ai-gateway` → `acegalaxy-co/lib-ai-gateway` (2026-09-24),
  version bump lên `1.1.0`, chuyển hẳn sang **private git-dependency**
  (`github:acegalaxy-co/lib-ai-gateway#v1.1.0`) thay vì npm registry — package
  `private: true` chặn publish nhầm, vì `authz/policies.json` +
  `config/proxy.json` là kiến trúc nội bộ không nên public.
- Fix mới nhất (`e0e2c1d`): bổ sung `cloak_evaluate` vào `allowedTools` cho
  skill `crawler.extract` ở mọi tier — vá gap authz phát hiện khi vận hành.

**Deferred / chưa implement:**
- **31/123 test fail** ở snapshot hiện tại (`npm test` → 92 pass, 31 fail),
  cùng tỷ lệ trước và sau đợt rename — nguyên nhân là các test phụ thuộc env
  config/API key thật (proxy endpoint, model registry cache) chưa được mock
  đầy đủ khi chạy standalone ngoài context Nexus. Nên tách rõ 2 tầng test:
  unit (mock hoàn toàn, luôn chạy được ở CI mọi máy) vs integration (cần
  `AI_GATEWAY_CONFIG_ROOT` trỏ fixture đầy đủ) — hiện lẫn chung
  `test/*.test.js` nên fail bị coi là "pre-existing, chấp nhận được" thay vì
  được cô lập và xanh thật.
- Không có CI workflow verify cho package này (chỉ `.github/workflows/`
  legacy còn sót publish.yml kiểu npm-publish từ thời chưa private — cần dọn
  ở bước commit-time riêng, không thuộc scope RESEARCH.md này).
- `AI_GATEWAY_CONFIG_ROOT` mặc định walk-up từ vị trí package — README tự
  nhận "unreliable inside node_modules"; mỗi consumer phải tự nhớ set biến
  này tường minh, chưa có validate/fail-fast lúc load nếu quên set.
- Model resolution qua env override chỉ áp cho Anthropic — chưa có cơ chế
  tương đương cho DeepSeek/Gemini khi cần swap khẩn cấp.
- SSH deploy-key requirement cho private git-dependency chưa có
  self-check/health-check trong package — mỗi consumer tự lo `ssh-add` +
  `ssh-keyscan` lúc build Docker, dễ quên khi thêm consumer mới.
