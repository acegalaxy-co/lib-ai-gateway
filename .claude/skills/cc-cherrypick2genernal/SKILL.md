---
name: cc-cherrypick2genernal
description: Quét global (~/.claude) và mọi repo trong projects_repos tìm rule/skill/agent/hook dùng chung chưa có trong harness ccswitch, phân tầng common/ace, quét secret, cherry-pick vào harness/templates(-ace). Dùng /cc-cherrypick2genernal [scan|apply], hoặc khi user nói "cherry-pick rule/skill dùng chung", "gom skill chung về harness".
user-invocable: true
---

# cc-cherrypick2genernal

Chạy trong repo `github/ccswitch-cli-claude`, nhánh `ace-skill`.

## 1. scan (read-only)
Nguồn: `~/.claude/{skills,hooks,agents}` + `projects_repos/*/*/.claude/{skills,agents,hooks,rules/common,rules/project}`.
Đích so sánh: `harness/templates/{skills,agents,hooks,rules/*}` + `harness/templates-ace/skills`.
Liệt kê mục chưa có trong harness, đếm số repo chứa (nhiều repo = ứng viên mạnh).

## 2. phân loại
- **Bỏ**: gắn code 1 repo (deploy-<app>, bot-*, cocos-*, seo-*, facebook-*, game-copy). Không đưa.
- **common** (`harness/templates/…`): không nhắc host/domain/tổ chức nội bộ (pattern cấm nằm trong test `skills-packaging` → "templates contain no org/machine hardcodes").
- **ace** (`harness/templates-ace/skills/`): dùng chung nhưng nhắc hạ tầng ACE. Chỉ skill; agent/hook/rule ace chưa có overlay → hỏi user.
- Bản trùng tên nhiều repo → so `diff`, lấy bản mới nhất/đầy đủ nhất, báo khác biệt.

## 3. apply
1. Copy mục chọn vào đích. KHÔNG sửa nội dung nguồn.
2. Quét: `grep -rEI 'sk-[A-Za-z0-9]{20}|ghp_|glpat-|AKIA|BEGIN .*PRIVATE|[0-9]{8,}:AA[A-Za-z0-9_-]{30}'` + file ≥ 99 MB. Có hit → dừng, báo tên file.
3. Hook mới: chưa wire `settings.json` — hỏi user trước (hook chặn ảnh hưởng mọi session).
4. `main` KHÔNG được chứa `templates-ace/**` (gate `.claude/private-paths.txt`).
5. Commit scope harness; push `origin ace-skill` rồi `kane ace-skill` (qua `/git-push-safety`). Không push `github`.

Báo bảng: mục | tầng | nguồn | bỏ/giữ + lý do.
