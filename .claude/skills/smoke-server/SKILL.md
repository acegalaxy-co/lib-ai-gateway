---
name: smoke-server
description: TỰ ĐỘNG dùng khi user muốn test SERVER Gse-Engine - "test server", "smoke server", "test engine", "test API", "unit test game", "test whitelabel", "deploy rồi test". Smoke server (G1) - gradle test engine + từng game (chạy trên macmini2), server thật là node gộp container gse-staging (reload game bằng /deploy-macmini2 staging game <g> reload). Gọi được bằng /smoke-server [status|run].
---

# smoke-server (G1)

## Song song (BẮT BUỘC — user chốt 2026-10-14)

Quy tắc fan-out (1-2 agent/game, ≤20 agent/wave, mọi loại test chạy song song, ngoại lệ tuần tự): xem mục "Song song" của [[smoke-test]] (bản gốc duy nhất).

Script: `node scripts/smoke/smoke.mjs` (`status`, `g1`). Kịch bản: `../ace_ace_island-bot-player/docs/client-e2e.md` §7 (repo BotControl). Game chạy trong node gộp `gse-staging` (macmini2, table-game.acesandbox.com), không còn JVM từng game; lỗi → Telegram `@acegse`.

0. **Profile trước:** `smoke.mjs profiles` (idempotent) rồi mọi flow dùng `--profile <game>-app` / `<game>-peer`, không tạo guest mới giữa chừng. Thiếu profile → dừng.
1. `smoke.mjs status` (read-only): SHA deploy vs `kane-staging-fixbug`, gate gần nhất.
2. `AskUserQuestion` (1 câu): **Có build/deploy server mới không?** Kèm số liệu `status` (deploy=`<sha>` kane-staging-fixbug=`<sha>` lệch n commit; commit lệch có đổi code runtime hay chỉ docs?). 
   - Có → build + deploy staging qua `/deploy-macmini2 staging game <g> reload` (reload nóng 1 game) hoặc `staging all deploy` (cả container); build `sources/games/gradlew -p sources/games distAll` (+ `scripts/git-archive-src.sh` cho submodule `_orig`). Trước deploy bắt buộc `(cd ${GSE_CORE_REPO:-../ace_engine-ace-server-game} && ./gradlew :gse-testkit:securityScan -Dorg.gradle.workers.max=2)` trên đúng SHA ([[deploy-sqli-scan]]); vi phạm mới → dừng.
   - Không → `SMOKE_REUSE=1`: bỏ gradle test, dùng bản đang chạy; report ghi "test trên bản `<sha>`".
3. `smoke.mjs g1` (= SERVER; `server` là alias): gradle test song song theo job engine (repo core: `cd ${GSE_CORE_REPO:-../ace_engine-ace-server-game} && ./gradlew test`) + game (ở đây: `sources/games/gradlew -p sources/games :<module>:test`) qua `run-gate.mjs` (kết quả `~/apps/gse-server/logs/gate-<runId>/<job>.{log,rc}` + `meta.json` có SHA `src`; con trỏ `gate-latest`; mỗi job giữ lease `gate:<job>` — job đang chạy ở lượt khác → rc=75 "bận"; report + Telegram từng job khi xong). Job đỏ không chặn job khác; kết luận đỏ sau khi tất cả xong. `GSE_GATE_JOBS=ludo,chess` để chạy hẹp. Whitelabel staging: `scripts/macmini2/staging-wl-creds.mjs <game|all>` (plan, probe).
4. Report: gate PASS/FAIL, SHA đã test, whitelabel stub hay thật (nếu có kiểm), cảnh báo log boot (wallet op treo, schema thiếu).

Ranh giới (hỏi user): kill soak/chain macmini2, deploy khi soak đang chạy, đụng prod pm2 (không bao giờ).
