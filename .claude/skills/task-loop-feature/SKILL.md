---
name: task-loop-feature
description: "Task loop tự chạy tới khi xong thật: spec + rubric đóng băng, TDD mỗi vòng, /goal giữ vòng lặp, reviewer độc lập chấm, ngân sách vòng + thoát BLOCKED. Dùng khi \"làm tới khi xong\", \"chạy loop\", hoặc /task-loop-feature <task>."
user-invocable: true
---

# task-loop-feature — mô tả task, chạy loop tới khi acceptance đạt thật

Method nền: [skill-superpowers.md](../../rules/project/skill-superpowers.md) (TDD red-green-refactor, debug 4 bước). Skill này thêm **khung loop**: spec đóng băng → vòng lặp có state → verifier riêng → ngân sách → report. Chỉ dừng khi check chạy thật pass VÀ reviewer độc lập APPROVE, hoặc khi guard báo BLOCKED.

**Lệnh test (`<test>` bên dưới):** lệnh test của project: `npm test`. Có typecheck/lint trong repo → chạy kèm.

## Input

- Không có mô tả task (arg rỗng/placeholder) → hỏi user, KHÔNG đoán, KHÔNG tạo state.
- Có task, thiếu acceptance → tự suy từ task + code; chỉ hỏi khi không đoán được "xong" nghĩa là gì.
- Đã có `.claude/state/loop-<slug>/` dở (`status: running`) → resume từ đó, không tạo lại.

## Bước 0 — Chuẩn bị (1 lần)

1. `slug` = kebab-case từ task. Tạo `.claude/state/loop-<slug>/` (runtime, không commit):
   - `spec.md` — **đóng băng**: yêu cầu user nguyên văn + rubric `R1..Rn`, mỗi R = 1 điều kiện đo được kèm cách kiểm (vd `R1: <test> exit 0`, `R2: GET /x trả 404 khi id sai — test test/x.test.ts`) + cột `passes: false`. Cấm R mơ hồ kiểu "code sạch". Sau khi tạo CHỈ được đổi `passes`; muốn đổi nội dung R → dừng hỏi user.
   - `progress.md` — append-only. Đầu file `## Patterns` (kiến thức tái dùng); mỗi vòng 1 mục `## vòng N — <giờ>`: làm gì, file đổi, kết quả check, learnings.
   - `state.json` — `{"iteration":0,"max_iterations":10,"no_progress":0,"same_error":{"sig":"","count":0},"status":"running"}`.
2. **Smoke baseline** — chạy `<test>` TRƯỚC khi sửa gì. Đỏ sẵn → ghi tên test vào `spec.md` mục `Baseline đỏ`; không tính là lỗi của loop, không sửa lan trừ khi nằm trong rubric.
3. **Chẻ story** khi task không vừa 1 context: mỗi story (id, acceptance, priority, passes) trong `spec.md`, **1 story/vòng**. ≥2 story WRITE độc lập muốn chạy song song → `/orchestrate`; skill này giữ rubric + verifier.
4. **UI/web** → rubric PHẢI có R kiểm bằng browser headless (screenshot/DOM), không chỉ unit test.
5. **Bật loop:**
   ```text
   /goal Theo .claude/state/loop-<slug>/spec.md: mọi R passes=true kèm output check trong transcript, <test> exit 0, reviewer trả "VERDICT: APPROVE", git status sạch sau commit. Dừng nếu state.json status=BLOCKED hoặc sau 10 vòng.
   ```
   Không có `/goal` (headless, hook tắt) → tự lặp trong turn theo mục Vòng lặp, đọc `state.json` đầu mỗi vòng.

## Vòng lặp (mỗi vòng = 1 R hoặc 1 story)

1. **Đọc lại state** — `state.json` + `progress.md` + R đang làm. Sau compact/resume tiếp đúng chỗ, không phân tích lại từ đầu.
2. **RED** — viết test fail đúng lý do (chưa có behavior, không phải lỗi test), theo pattern test có sẵn cùng module.
3. **GREEN** — code tối thiểu cho test pass. Không sửa ngoài R đang làm.
4. **Check song song** — typecheck ‖ lint ‖ `<test>` trong 1 message nhiều Bash call (suite nặng → chỉ file liên quan; full suite trước khi gọi reviewer). Đọc output thật, không suy đoán.
5. **Fail** → debug 4 bước: reproduce → isolate → root cause giải thích được VÌ SAO → fix → quay bước 4. Cập nhật `same_error.sig` (dòng lỗi chuẩn hoá) + `count` (reset khi lỗi khác).
6. **Pass** → rà edge case của R (input lỗi, biên, guard cũ); thiếu → quay bước 2. Refactor chỉ khi xanh, chạy lại bước 4.
7. **Chốt vòng** — commit 1 R/story `feat|fix: [R<n>] <tóm tắt>` CHỈ khi check xanh; set `passes: true`; append `progress.md`; `iteration++`; `no_progress` = 0 nếu vòng có đổi file, ngược lại +1.
8. Còn R `passes: false` → vòng mới. Hết → Verifier.

## Verifier (generator ≠ verifier)

- Dispatch agent `code-reviewer` (read-only): prompt kèm path `spec.md` + range commit của loop + "chấm từng R: SATISFIED/MISSING kèm bằng chứng, skip style".
- `VERDICT: REVISE` → R bị MISSING đặt lại `passes: false`, vòng mới.
- `VERDICT: APPROVE` + check xanh → thoát loop, sang Report.
- Loop KHÔNG tự phát `APPROVE`, không sửa verdict của reviewer.

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
- BLOCKED → kẹt ở đâu, đã thử gì, cần gì từ user.
- APPROVE → learnings tái dùng chuyển vào memory/CLAUDE.md vùng liên quan, rồi xoá `.claude/state/loop-<slug>/`.
