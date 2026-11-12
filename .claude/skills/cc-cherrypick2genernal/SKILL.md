---
name: cc-cherrypick2genernal
description: Quét global (~/.claude) và mọi repo trong projects_repos tìm rule/skill/agent/hook dùng chung chưa có trong harness ccswitch, phân tầng common/ace, quét secret, cherry-pick vào harness/templates(-ace). Dùng /cc-cherrypick2genernal [scan|apply], hoặc khi user nói "cherry-pick rule/skill dùng chung", "gom skill chung về harness".
user-invocable: true
---

# cc-cherrypick2genernal

Chạy trong repo `github/ccswitch-cli-claude`, nhánh `main`.

## 1. scan (read-only)
Nguồn: `~/.claude/{skills,hooks,agents}` + `projects_repos/*/*/.claude/{skills,agents,hooks,rules/common,rules/project}`.
Đích so sánh: `harness/templates/{skills,agents,hooks,rules/*}` (skill dưới `harness/templates/skills/<group>/<skill>`: `common/`, `ace-shared/`, nhóm project).
Liệt kê mục chưa có trong harness, đếm số repo chứa (nhiều repo = ứng viên mạnh).

## 2. phân loại
- **Bỏ**: gắn code 1 repo (deploy-<app>, bot-*, cocos-*, seo-*, facebook-*, game-copy). Không đưa.
- **common** (`harness/templates/…`): không nhắc host/domain/tổ chức nội bộ (pattern cấm nằm trong test `skills-packaging` → "templates contain no org/machine hardcodes").
- **ace** (`harness/templates/skills/ace-shared/ace-<việc>/` hoặc nhóm project `<group>/ace-<project>-<việc>/` kèm dòng `sources.tsv`, tiền tố `ace-` bắt buộc): dùng chung nhưng nhắc hạ tầng ACE. Chỉ skill; agent/hook/rule ace chưa có quy ước → hỏi user.
- Bản trùng tên nhiều repo → so `diff`, lấy bản mới nhất/đầy đủ nhất, báo khác biệt.

## 3. apply
1. Copy mục chọn vào đích. KHÔNG sửa nội dung nguồn.
2. Quét: `grep -rEI 'sk-[A-Za-z0-9]{20}|ghp_|glpat-|AKIA|BEGIN .*PRIVATE|[0-9]{8,}:AA[A-Za-z0-9_-]{30}'` + file ≥ 99 MB. Có hit → dừng, báo tên file.
3. Hook mới: chưa wire `settings.json` — hỏi user trước (hook chặn ảnh hưởng mọi session).
4. Skill `ace-*` chỉ push remote private trong allowlist (gate `.claude/private-paths.txt`, tiền tố `harness/templates/skills/ace-shared` + từng nhóm project).
5. Commit scope harness; push `origin main` rồi `kane main` + `github main` (qua `/git-push-safety`, cả 3 remote đều private).

Báo bảng: mục | tầng | nguồn | bỏ/giữ + lý do.
