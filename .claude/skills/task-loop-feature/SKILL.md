---
name: task-loop-feature
description: "Task loop tới khi xong thật: code/fix TDD → smoke → commit → merge → dọn dẹp → build & deploy (khi được nêu). Spec đóng băng, reviewer độc lập, thoát BLOCKED. Dùng /task-loop-feature <task>."
user-invocable: true
---

# task-loop-feature — mô tả task, chạy loop tới khi acceptance đạt thật

Method nền: [skill-superpowers.md](../../rules/project/skill-superpowers.md) (TDD red-green-refactor, debug 4 bước). Skill này thêm **khung loop**: spec đóng băng → vòng lặp có state → verifier riêng → ngân sách → report. Chỉ dừng khi check chạy thật pass VÀ reviewer độc lập APPROVE VÀ xong phần Hoàn tất (smoke → merge → dọn dẹp → deploy nếu được nêu), hoặc khi guard báo BLOCKED.

Luồng: **code/fix (TDD) → test → commit → verifier → smoke cuối → merge (nếu được) → dọn dẹp → build & deploy (chỉ khi prompt nêu deploy) → report.**

**Lệnh test (`<test>` bên dưới):** lệnh test của project: `npm test`. Có typecheck/lint trong repo → chạy kèm.

## Input

- Không có mô tả task (arg rỗng/placeholder) → hỏi user, KHÔNG đoán, KHÔNG tạo state.
- Có task, thiếu acceptance → tự suy từ task + code; chỉ hỏi khi không đoán được "xong" nghĩa là gì.
- Đã có `.claude/state/loop-<slug>/` dở (`status: running`) → resume từ đó, không tạo lại.

## Bước 0 — Chuẩn bị (1 lần)

1. `slug` = kebab-case từ task. Tạo `.claude/state/loop-<slug>/` (runtime, không commit):
   - `spec.md` — **đóng băng**: yêu cầu user nguyên văn + rubric `R1..Rn`, mỗi R = 1 điều kiện đo được kèm cách kiểm (vd `R1: <test> exit 0`, `R2: GET /x trả 404 khi id sai — test test/x.test.ts`) + cột `passes: false`. Cấm R mơ hồ kiểu "code sạch". Sau khi tạo CHỈ được đổi `passes`; muốn đổi nội dung R → dừng hỏi user.
   - `progress.md` — append-only. Đầu file `## Patterns` (kiến thức tái dùng); mỗi vòng 1 mục `## vòng N — <giờ>`: làm gì, file đổi, kết quả check, learnings.
   - `state.json` — `{"iteration":0,"max_iterations":10,"no_progress":0,"same_error":{"sig":"","count":0},"status":"running","branch":"","base_sha":"","worktree":"","deploy":false}`.
2. **Chọn nhánh** theo rule git của project (`git-workflow`): 1 session → sửa thẳng trên working branch; repo đang có session khác / user yêu cầu → worktree `.claude/worktrees/<slug>` + `feat|fix/<slug>`. Ghi `branch`, `base_sha` (`git rev-parse HEAD`), `worktree` vào `state.json`. Có thay đổi lạ chưa commit trên nhánh → dừng, báo user (session khác).
3. **Deploy?** — `deploy: true` CHỈ khi prompt hiện tại nêu rõ deploy (vd "xong thì deploy"); không thì `false` (Merge ≠ deploy).
4. **Smoke baseline** — chạy `<test>` TRƯỚC khi sửa gì. Đỏ sẵn → ghi tên test vào `spec.md` mục `Baseline đỏ`; không tính là lỗi của loop, không sửa lan trừ khi nằm trong rubric.
5. **Chẻ story** khi task không vừa 1 context: mỗi story (id, acceptance, priority, passes) trong `spec.md`, **1 story/vòng**. ≥2 story WRITE độc lập muốn chạy song song → `/orchestrate`; skill này giữ rubric + verifier.
6. **UI/web** → rubric PHẢI có R kiểm bằng browser headless (screenshot/DOM), không chỉ unit test.
7. **Bật loop:**
   ```text
   /goal Theo .claude/state/loop-<slug>/spec.md: mọi R passes=true kèm output check trong transcript, <test> exit 0, reviewer trả "VERDICT: APPROVE", smoke cuối pass, git status sạch, đã merge (nếu làm trên nhánh tạm), đã dọn dẹp, deploy=true thì đã deploy + probe live pass; xong in Report. Dừng nếu state.json status=BLOCKED hoặc sau 10 vòng.
   ```
   Không có `/goal` (headless, hook tắt) → tự lặp trong turn theo mục Vòng lặp, đọc `state.json` đầu mỗi vòng.

## Vòng lặp (mỗi vòng = 1 R hoặc 1 story)

1. **Đọc lại state** — `state.json` + `progress.md` + R đang làm. Sau compact/resume tiếp đúng chỗ, không phân tích lại từ đầu.
2. **RED** — viết test fail đúng lý do (chưa có behavior, không phải lỗi test), theo pattern test có sẵn cùng module.
3. **GREEN** — code tối thiểu cho test pass. Không sửa ngoài R đang làm.
4. **Check song song** — typecheck ‖ lint ‖ `<test>` trong 1 message nhiều Bash call (suite nặng → chỉ file liên quan; full suite trước khi gọi reviewer). Đọc output thật, không suy đoán.
5. **Fail** → debug 4 bước: reproduce → isolate → root cause giải thích được VÌ SAO → fix → quay bước 4. Cập nhật `same_error.sig` (dòng lỗi chuẩn hoá) + `count` (reset khi lỗi khác).
6. **Pass** → rà edge case của R (input lỗi, biên, guard cũ); thiếu → quay bước 2. Refactor chỉ khi xanh, chạy lại bước 4.
7. **Chốt vòng** — commit 1 R/story `feat|fix: [R<n>] <tóm tắt>` CHỈ khi check xanh, chỉ stage file của R đó (không `git add -A`); push theo rule git của project (có rule push từng mốc → `/git-push-safety`; không có hoặc user nói không push → giữ local); set `passes: true`; append `progress.md`; `iteration++`; `no_progress` = 0 nếu vòng có đổi file, ngược lại +1.
8. Còn R `passes: false` → vòng mới. Hết → Verifier.

## Verifier (generator ≠ verifier)

- Dispatch agent `code-reviewer` (read-only): prompt kèm path `spec.md` + range commit của loop + "chấm từng R: SATISFIED/MISSING kèm bằng chứng, skip style".
- `VERDICT: REVISE` → R bị MISSING đặt lại `passes: false`, vòng mới.
- `VERDICT: APPROVE` + check xanh → thoát vòng lặp, sang Hoàn tất.
- Loop KHÔNG tự phát `APPROVE`, không sửa verdict của reviewer.

## Hoàn tất (sau APPROVE, theo thứ tự)

1. **Smoke cuối** — chạy app thật bằng smoke của project (`/ace-smoke-test`, `/ace-smoke-server`, hoặc lệnh trong README/CI: khởi động server/CLI, probe route/lệnh chính, UI thì screenshot headless). Process con tự spawn phải có watchdog + hard timeout. Fail → R liên quan `passes: false`, quay Vòng lặp.
2. **Merge (nếu được)** — chỉ khi làm trên nhánh tạm (`feat|fix/<slug>`). Có `.claude/fix-ledger.md` → `/fix-ledger` CHECK trước. Merge vào working branch theo `git-conventions` (fast-forward/đồng bộ nhánh, push theo rule project). Conflict / diverged / session khác đang dở trên nhánh đích → BLOCKED, không tự rebase/force. Đã sửa thẳng trên working branch → bỏ qua bước này.
3. **Dọn dẹp** — liệt kê: worktree + nhánh tạm đã merge, process con còn sống (server/browser do loop mở), file tạm của loop, `.claude/state/loop-<slug>/` → **hỏi user xác nhận** rồi mới xoá (`/git-cleanup-branch`, `git branch -d`, không `-D`/`rm -rf` khi chưa được đồng ý). Learnings tái dùng chuyển vào memory/CLAUDE.md TRƯỚC khi xoá state.
4. **Build & deploy** — CHỈ khi `deploy: true`. Theo skill deploy của project (`deploy-production`, `deploy-production rsync <target>`, hoặc skill/rule deploy riêng repo): deploy từ working branch sạch đã merge, in mẫu confirm deploy (commit sẽ ship), build, deploy, probe live mọi route chính, ghi lại SHA đã deploy. Probe fail → BLOCKED, báo user (không tự rollback khi skill deploy không quy định). `deploy: false` → không build/deploy, ghi "chưa deploy" vào Report.

## Guard — dừng, không "cố thêm"

| Điều kiện | Hành động |
|---|---|
| `iteration ≥ max_iterations` (mặc định 10) | `status: BLOCKED` — hết ngân sách |
| `no_progress ≥ 3` (3 vòng không đổi file) | BLOCKED — nghi spec sai/thiếu thông tin |
| `same_error.count ≥ 3` | BLOCKED — liệt kê cách đã thử |
| Cần quyết định thiết kế ngoài spec / thiếu tool / story quá lớn | BLOCKED ngay, không auto-retry |
| Sửa nội dung rubric, xoá/skip test, `.only`, xoá assert cho xanh | Vi phạm → revert, ghi `progress.md`. Sửa test hợp lệ phải ghi lý do |

BLOCKED = ghi `state.json`, report, dừng. Không re-dispatch mù, không nới rubric.

## Report (1 lần, cuối)

- R đạt/chưa đạt, số vòng, test thêm/sửa, danh sách commit.
- Lệnh verify cuối + output thật (exit code, số pass/fail) + verdict reviewer nguyên văn.
- Git: repo, branch, commit SHA, đã merge chưa, remote đã push (verify bằng `git ls-remote`/fetch so SHA) hoặc "chỉ local, chưa push".
- Smoke cuối + deploy: kết quả probe thật, SHA đã deploy; hoặc "chưa deploy" (không được nêu).
- Dọn dẹp: đã xoá gì (user đã xác nhận), còn giữ gì.
- BLOCKED → kẹt ở đâu, đã thử gì, cần gì từ user.
