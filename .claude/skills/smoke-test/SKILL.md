---
name: smoke-test
description: Điều phối khi user nói "test" chung chung, "smoke", "test lại từ đầu", "test cả server và client" mà chưa nói rõ phía nào. Hỏi server / client / cả hai rồi gọi smoke-server và smoke-client; build 2 phía song song. Cũng gọi được bằng /smoke-test [clean|all].
---

# smoke-test (điều phối)

## Song song (BẮT BUỘC — user chốt 2026-10-14)

- Smoke **nhiều game** → mỗi game **1-2 agent riêng**, dispatch tất cả trong **1 message** để chạy song song. Cấm 1 agent (hoặc 1 vòng `for`) chạy lần lượt nhiều game.
- Test **client + server song song** → giao **tối đa agent (30)**. Trần thật = `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (mặc định 20) → vượt thì chia wave. Memory `test-fanout-30-agents`.
- **MỌI loại test** — suite/full test (cả bộ `gradle test` toàn repo), unit toàn bộ module, integration/e2e, test từng game, test API/service/whitelabel — BẮT BUỘC chạy song song, không có ngoại lệ "chạy riêng cho chắc". Công cụ: (a) runner song song nội bộ (full suite chạy mọi module cùng lúc + class song song trong JVM, ưu tiên virtual thread): Gradle `org.gradle.parallel` + `maxParallelForks` (`-Pgse.test.forks=N`, ≤30; `-Pgse.test.serial` chỉ để debug 1 test), `xargs -P`, `&`+`wait`, virtual thread/worker pool trong code test client; (b) multi-agent (≤30, 1 message) cho N target độc lập cần suy luận/log riêng (game × API × platform). Tổng song song ≤30; state chung (port/account/room/tmpdir) tách riêng từng worker; test fail chỉ khi chạy song song → sửa cho parallel-safe, không tắt song song. Runner/script chưa song song → bổ sung ngay.
- Vẫn tuần tự (tài nguyên dùng chung): build Cocos cùng project, Gradle cùng worktree, 1 emulator/simulator mỗi app — build xong rồi mới fan-out agent test.

Kịch bản đầy đủ: `../ace_ace_island-bot-player/docs/client-e2e.md` §7 (repo BotControl), diagram `docs/diagrams/smoke-test.md`. Memory: `gse-smoke-test-scenario`.

- User nói rõ "test server" → dùng skill `smoke-server`; "test client/web/android/ios" → skill `/smoke-client` ở repo `ace_ace_island-bot-player` (mở session ở đó; build Cocos + chơi game trên browser đều nằm bên đó). Skill này chỉ cho trường hợp chung chung.
0. **Bước đầu tiên luôn là profile:** `node scripts/smoke/smoke.mjs profiles` (tạo/kiểm pool profile guest, xem `../ace_ace_island-bot-player/docs/client-e2e.md` §Bước 0). Chưa có/thiếu/hỏng profile thì dừng, không chạy G1/G2.
1. `AskUserQuestion`: test **Server / Client / Cả hai**.
2. `smoke.mjs status` rồi để mỗi skill hỏi build riêng phần của mình (hỏi 1 lần gộp cho cả hai nếu chọn cả hai).
3. Cả hai: pha build server (deploy macmini2) và client (Cocos web, rồi android/ios nền) chạy SONG SONG; xong **server trước** (`smoke-server` G1 = cổng) rồi mới `smoke-client` (repo BotControl). Server đỏ → không chạy client. Client chỉ cần fleet up, không cần server vừa build.
4. `smoke.mjs clean` đầu phiên "test từ đầu" (gõ tay = `--all`: kill web, tunnel, MỌI tab, emulator, simulator — chỉ khi không có lượt smoke khác đang chạy; có lượt khác → `clean --mine`; KHÔNG đụng server staging). Nhiều lượt smoke song song an toàn nhờ lease (`../ace_ace_island-bot-player/docs/client-e2e.md` §7 "Lease / khoá"). `smoke.mjs all [--server g,g] [--client g,g]` (tự dùng `clean --mine`, tối đa `SMOKE_MAX_PAR`=4 tab client) = 2 queue song song (server: gradle test; client: profile ∥ chờ server X → g2 X ngay; server X đỏ → client X SKIP; game chỉ ở client → start ngay, server = node gộp `gse-staging` có sẵn); g1 = SERVER, g2 = CLIENT. Kill soak / gradle local là việc riêng, hỏi user.
5. Report gộp: SHA server + build client đã test, bảng game × nền tảng.
