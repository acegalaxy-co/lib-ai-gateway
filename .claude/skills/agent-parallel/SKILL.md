---
name: agent-parallel
description: Giao nhiều việc độc lập cho subagent chạy SONG SONG trong cùng session (Agent tool, nhiều tool-call trong 1 message) — chẻ việc, chọn agent type, worktree cho việc ghi file, gom kết quả, main session review + commit. Dùng /agent-parallel <việc 1> | <việc 2> | ..., hoặc khi user nói "chạy song song", "giao cho agent khác", "chia agent", "subagent làm cùng lúc".
---

# agent-parallel

Subagent = Agent tool. Chạy trong session này, context riêng, chỉ trả báo cáo cuối về main (user không thấy báo cáo đó → main phải tóm tắt lại).
Task lớn cần task-graph + gate (repo có harness ccswitch) → dùng `/orchestrate` thay skill này.

## 1. Chẻ việc

Tách theo dấu `|` trong tham số, hoặc tự chẻ từ yêu cầu. Mỗi mảnh phải độc lập thật:
- không cùng sửa 1 file với mảnh khác (trùng file → gộp 1 mảnh, hoặc chạy nối tiếp);
- không cần kết quả của mảnh khác (cần → để wave sau);
- tự verify được (lệnh test/probe riêng).

Chỉ 1 mảnh, hoặc việc ngắn hơn công viết prompt → tự làm, không spawn.

## 2. Chọn agent type

| Việc | subagent_type |
|---|---|
| Tìm/đọc nhiều file, chỉ cần kết luận | `Explore` |
| Audit/tóm tắt context lớn read-only | `delegate-gemini` |
| Sửa cơ học (rename, config, boilerplate) | `delegate-codex-luna` → fallback `delegate-claude-haiku` |
| Feature/bugfix thường | `delegate-codex-terra` → fallback `delegate-claude-sonnet` |
| Bug khó, security, invariant tinh vi | `delegate-codex-sol` → fallback `delegate-claude-opus` |
| Review diff / quét secret | `code-reviewer` / `secret-scanner` |
| Browser theo profile | `browser-*` đúng dịch vụ |
| Còn lại | `general-purpose` |

Danh sách thật nằm trong system-reminder của session — type không có → `general-purpose`.

## 3. Dispatch

- Mọi mảnh cùng wave → **1 message, nhiều Agent tool-call** (mới chạy concurrent). Tối đa ~10/wave.
- Mảnh GHI file trên cùng repo song song → `isolation: "worktree"` để không giẫm nhau. Read-only → không cần.
- Prompt self-contained (subagent không thấy hội thoại này):
  - repo path tuyệt đối + branch; Bash mở đầu `cd <repo> && …` vì subagent không kế thừa cwd/ngữ cảnh;
  - mục tiêu, file được phép chạm, quyết định thiết kế đã chốt (không để subagent tự đoán);
  - lệnh verify + tiêu chí xong;
  - "KHÔNG commit/push/deploy — chỉ sửa working tree, báo diff + kết quả verify";
  - rule bắt buộc liên quan (secret không in, phạm vi file được chạm, rule riêng của repo…).
- Mặc định chạy nền; main làm việc khác hoặc chờ notification. KHÔNG đoán/bịa kết quả agent chưa xong.

## 4. Gom + review

- Mỗi agent xong → đọc báo cáo, kiểm diff (`git -C <repo> diff`, hoặc trong worktree agent trả về), chạy lại verify.
- Cần sửa → `SendMessage` tới ĐÚNG agent đó (giữ context), không spawn mới.
- Worktree → main merge/cherry-pick vào nhánh làm việc; xung đột → main tự giải.

## 5. Kết thúc

- Main (không phải subagent) commit (+ push) theo rule git của repo/global; từng mảnh pass → commit ngay.
- Báo user bảng: mảnh | agent | kết quả | commit SHA; mảnh fail/chưa xong ghi rõ.
