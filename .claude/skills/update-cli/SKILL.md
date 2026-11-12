---
name: update-cli
description: "Kiểm tra + cập nhật CLI AI lên bản mới nhất: Claude Code (native `claude update` + Homebrew), OpenAI Codex (Homebrew Cask, chạy qua subagent haiku vì hook chặn main gọi codex), Google Gemini CLI (Homebrew vs npm, formula deprecated), Aider sau delegate-deepseek (+ check env/endpoint DeepSeek, không in secret); check agent auto-upgrade còn sống. Dùng /update-cli <claude|codex|gemini|deepseek|all>, hoặc khi user nói \"update claude\", \"update codex\", \"update gemini\", \"update deepseek\", \"update aider\", \"cập nhật CLI\"."
user-invocable: true
---

# update-cli — kiểm tra + cập nhật CLI AI (claude / codex / gemini / deepseek)

## Tham số

`/update-cli <tool>` với `<tool>` ∈ `claude` | `codex` | `gemini` | `deepseek` | `all`. Thiếu → hỏi user, không đoán. `all` = chạy lần lượt cả 4 (codex vẫn qua subagent, xem mục codex), gộp 1 bảng báo cáo.

## Luồng chung (mọi tool)

1. **Bước 1 — Trạng thái hiện tại** (read-only): bản đang chạy (`which -a` + `--version`), bản Homebrew (nếu có `brew`; không có → kiểm tra cách cài khác npm/pipx/pip/native), agent auto-upgrade. Lệnh check agent dùng chung, thay `<pat>` bằng pattern của tool (bảng dưới):
   ```bash
   echo "agents  :"
   case "$(uname)" in
     Darwin) launchctl list | grep -iE "<pat>" || echo "  (không agent nào loaded)" ;;
     *) { crontab -l 2>/dev/null | grep -iE "<pat>"; systemctl --user list-timers 2>/dev/null | grep -iE "<pat>"; } || echo "  (không cron/timer nào)" ;;
   esac
   ```
   Tìm thấy agent/timer → lấy log gần nhất qua tên/label thực tế vừa liệt kê (vd `tail -n 2` trên log path plist khai báo `StandardOutPath`, hoặc `journalctl --user -u <timer>` trên Linux).
2. **Bước 2 — Cập nhật** theo cơ chế cài thực tế của tool (mục riêng bên dưới). Không trộn 2 cơ chế update trên cùng 1 install.
3. **Bước 3 — (tuỳ chọn)** bước riêng từng tool (ép brew, `codex update`, đổi install method gemini, reachability deepseek).
4. **Bước 4 — Báo cáo**: bảng ngắn version trước → sau + các cột riêng của tool. Nhắc: session/process CLI đang mở (kể cả wrapper `scripts/delegate/` của persona `delegate-*`) vẫn chạy binary cũ trong bộ nhớ — bản mới chỉ áp cho process spawn sau.

| Tool | Bản cài thường gặp | Pattern agent `<pat>` | Lệnh update chính | Ai cập nhật |
|---|---|---|---|---|
| `claude` | Native `~/.local/bin/claude` (bản chạy trên PATH) + có thể thêm Homebrew formula `claude-code` | `brew-upgrade\|claude` | `~/.local/bin/claude update` (native) + `brew upgrade claude-code` | Native: `claude update` tự update theo cơ chế riêng, KHÔNG do cron. Brew: agent auto-upgrade định kỳ (nếu có) |
| `codex` | Homebrew Cask: `$(command -v codex)` → symlink vào `$(brew --prefix)/Caskroom/codex/<version>/bin/codex` | `brew-upgrade\|codex` | `brew upgrade codex` | Agent auto-upgrade định kỳ (nếu có) |
| `gemini` | Homebrew formula `gemini-cli` (`$(command -v gemini)`); có thể thêm npm-global `@google/gemini-cli` | `brew-upgrade\|gemini` | `brew upgrade gemini-cli` | Agent auto-upgrade định kỳ (nếu có) |
| `deepseek` | Aider CLI `$(command -v aider)` (Homebrew formula `aider` nếu cài qua brew) | `aider\|deepseek` | `brew upgrade aider` | Thủ công — thường KHÔNG có agent auto-upgrade riêng cho aider (khác `claude-code`/`codex`/`gemini-cli` nếu các tool đó có) |

## claude — Claude Code CLI

Bẫy (có thể có 2 bản cài song song): agent auto-upgrade (nếu có) chỉ lo bản brew. Bản native đang chạy có thể cũ hơn dù brew báo "already installed". **Luôn check cả 2.**

```bash
echo "running : $(which claude) → $(claude --version 2>/dev/null)"
command -v brew >/dev/null && echo "brew    : $(brew info claude-code 2>/dev/null | head -1)" || echo "brew không có — kiểm tra cách cài khác (npm/pipx/native)"
# + khối check agent chung với <pat> = brew-upgrade|claude
```

Bước 2 — cập nhật bản native (bản đang chạy):

```bash
~/.local/bin/claude update 2>&1 | tail -n 10
echo "sau update: $(~/.local/bin/claude --version)"
```

Warning "Multiple installations found (npm-global + native cùng path)" là bình thường — không phải lỗi.

Bước 3 — (tuỳ chọn) ép brew upgrade ngay, không chờ cron:

```bash
command -v brew >/dev/null && brew upgrade claude-code 2>&1 | tail -n 5 || echo "brew không có — bỏ qua bước này"
```

Báo cáo: bản native trước → sau, bản brew (nếu có), agent auto-upgrade (loaded? log gần nhất lúc nào?). `claude update` fail → báo lỗi ngắn gọn (bản chất + nguồn), không dán log dài.

## codex — OpenAI Codex CLI (BẮT BUỘC qua subagent haiku)

Hook `pre-bash-gate.sh` chặn main agent gọi `codex` qua Bash (kể cả `codex --version`), không có bypass → main agent **KHÔNG** chạy trực tiếp các lệnh dưới. Thay vào đó:

1. In banner dispatch (persona + task + timeout).
2. Gọi Agent tool với `subagent_type: general-purpose`, `model: haiku`, foreground, prompt self-contained gồm: khối Bước 1 + Bước 2 dưới đây + verify `which -a codex` (copy nguyên lệnh), cấm chạy Bước 3 (`codex update`) trừ khi user yêu cầu rõ, cấm sửa/load plist hay launch agent, không sửa file, không commit — yêu cầu trả summary <200 từ: version trước → sau, cask version, `which -a codex` (cảnh báo nếu nhiều bản), agent auto-upgrade (loaded? plist label, log path + lần chạy gần nhất + dòng cuối log), lỗi nếu có.
3. Main agent chỉ làm Bước 4 (báo cáo) dựa trên kết quả subagent trả về — không tự chạy lại Bash.

Repo khác không có `pre-bash-gate.sh` → main vẫn nên delegate cho đồng nhất (không cần Bash trực tiếp cho tác vụ update CLI).

Bối cảnh: thường 1 bản cài qua Homebrew Cask. Có thêm bản npm-global (`@openai/codex`) hay standalone khác → Bước 1 sẽ phát hiện (npm global thường che PATH trước brew). `codex` có subcommand `codex update` riêng (tự tải bản mới), nhưng nếu bản cài là **Homebrew Cask** thì dùng `brew upgrade codex` làm cách chính để path/version khớp cơ chế cask (symlink Caskroom).

Bước 1 (subagent chạy):

```bash
echo "running : $(which codex) → $(codex --version 2>/dev/null)"
command -v brew >/dev/null && echo "cask    : $(brew info --cask codex 2>/dev/null | head -1)" || echo "brew không có — kiểm tra cách cài khác (npm/pipx/native)"
# + khối check agent chung với <pat> = brew-upgrade|codex
echo "npm-global (nên rỗng nếu chỉ dùng cask): $(npm ls -g --depth=0 2>/dev/null | grep -i codex)"
echo "which -a: $(which -a codex)"
if [ "$(uname)" = "Darwin" ]; then
  plist=$(ls ~/Library/LaunchAgents/*codex*.plist 2>/dev/null | head -1)
  [ -z "$plist" ] && plist=$(grep -il codex ~/Library/LaunchAgents/*.plist 2>/dev/null | head -1)
  if [ -n "$plist" ]; then
    log=$(/usr/libexec/PlistBuddy -c 'Print :StandardOutPath' "$plist" 2>/dev/null)
    if [ -n "$log" ] && [ -f "$log" ]; then
      echo "agent log ($plist → $log), mtime $(stat -f '%Sm' "$log"):"
      tail -n 5 "$log"
    else
      echo "agent log: plist $plist không có StandardOutPath hợp lệ"
    fi
  else
    echo "agent log: không tìm thấy plist codex trong ~/Library/LaunchAgents"
  fi
fi
```

Bước 2 (subagent chạy) — brew cask:

```bash
command -v brew >/dev/null && brew upgrade codex 2>&1 | tail -n 10 || echo "brew không có — bỏ qua bước này"
echo "sau update: $(codex --version)"
```

Bước 3 — (tuỳ chọn, chỉ khi user yêu cầu rõ) cần bản mới hơn brew-cask đã publish: `brew upgrade codex` phụ thuộc cask đã cập nhật lên homebrew-cask repo — có thể trễ vài giờ so với release GitHub.

```bash
codex update 2>&1 | tail -n 10
echo "sau codex update: $(codex --version)"
```

Cảnh báo: `codex update` có thể ghi binary ra ngoài path quản lý bởi brew (vd `~/.local/bin` hoặc tương tự) — sau đó chạy lại Bước 1 để xác nhận `which codex` vẫn trỏ đúng chỗ mong muốn, tránh 2 bản song song.

Báo cáo: version trước → sau, cask version, agent auto-upgrade. **Lưu ý delegate wrapper:** `scripts/delegate/` (persona `delegate-codex`) gọi thẳng binary `codex` trên PATH — wrapper đang chạy dở giữ binary cũ tới lần spawn tiếp theo. Thấy cả brew cask lẫn npm-global cùng có codex → cảnh báo user có 2 bản, dùng `which -a codex` xác định bản nào thắng PATH trước khi update. `brew upgrade codex` fail → báo lỗi ngắn gọn (bản chất + nguồn), không dán log dài.

## gemini — Google Gemini CLI

Bối cảnh: thường 1 bản cài qua Homebrew. Có thêm bản npm-global (`@google/gemini-cli`) song song → Bước 1 sẽ phát hiện.

**Bẫy nghiêm trọng hơn:** formula `gemini-cli` trên homebrew-core có thể bị **deprecated** — không còn được upstream support, có ngày sẽ bị **disable** (xem ngày cụ thể ghi trong `brew info gemini-cli`, dòng Deprecated/Disabled), thay thế đề xuất là `brew install --cask antigravity-cli`. Ngoài ra bottled version của brew có thể **lag phía sau** bản thật trên npm registry (`@google/gemini-cli`) — brew không tự bắt kịp release cadence của Google. Luôn so cả 2 nguồn, không chỉ tin `brew upgrade` "already installed".

```bash
echo "running : $(which gemini) → $(gemini --version 2>/dev/null)"
command -v brew >/dev/null && echo "brew    : $(brew info gemini-cli 2>/dev/null | head -1)" || echo "brew không có — kiểm tra cách cài khác (npm/pipx/native)"
echo "npm mới nhất: $(npm view @google/gemini-cli version 2>/dev/null)"
# + khối check agent chung với <pat> = brew-upgrade|gemini
```

So version brew vs npm: khác nhau → brew đang lag, cân nhắc Bước 3.

Bước 2 — cập nhật bản brew, không chờ cron:

```bash
command -v brew >/dev/null && brew upgrade gemini-cli 2>&1 | tail -n 10 || echo "brew không có — bỏ qua bước này"
echo "sau update: $(gemini --version)"
```

Bước 3 — (tuỳ chọn) brew vẫn lag xa npm hoặc gần ngày disable: cân nhắc chuyển sang cài trực tiếp qua npm (`npm install -g @google/gemini-cli`) hoặc migrate sang `antigravity-cli` — đây là quyết định đổi install method, KHÔNG tự làm, chỉ đề xuất cho user quyết.

Báo cáo: version brew trước → sau, version npm mới nhất, agent auto-upgrade, ngày formula bị disable (nếu `brew info` có ghi). `delegate-gemini` (`scripts/delegate/run-gemini.sh`) dùng CLI này cho task read-only large-context — session `gemini`/`delegate-gemini` đang chạy vẫn dùng binary cũ tới khi respawn. `brew upgrade gemini-cli` báo formula deprecated/disabled → tín hiệu cần migrate (Bước 3), không phải lỗi tạm thời.

## deepseek — Aider (backend delegate-deepseek) + env/endpoint

`delegate-deepseek` KHÔNG có "DeepSeek CLI" riêng — nó chạy Aider (Python CLI) trỏ vào model DeepSeek qua `scripts/delegate/run-aider-deepseek.sh`. Model + endpoint chọn động lúc chạy (không phải cài đặt cần update): resolved runtime trong wrapper qua `PROXY_9ROUTER_TOKEN`/`PROXY_9ROUTER_BASE_URL` (ưu tiên) hoặc `DEEPSEEK_API_KEY` (fallback endpoint DeepSeek trực tiếp — mặc định của aider/LiteLLM); tên model mặc định `DEEPSEEK_MODEL` → sửa trong `.env`, không phải "update". Không có agent auto-upgrade nghĩa là aider có thể cũ âm thầm — luôn check version trước khi tin nó mới nhất.

Bước 1 (read-only):

```bash
echo "aider bin : $(which -a aider)"
echo "aider ver : $(aider --version 2>&1 | head -1)"
if command -v brew >/dev/null; then
  brew info aider 2>&1 | head -6
  echo "outdated  :"; brew outdated 2>&1 | grep -i aider || echo "  (không outdated, hoặc chưa check được)"
else
  echo "brew không có — kiểm tra cách cài khác (pipx/pip)"
fi
# + khối check agent chung với <pat> = aider|deepseek
```

Kiểm tra env var cấu hình model/endpoint có tồn tại hay không, đọc từ chain `.env.local` → `.env` mà wrapper dùng (`scripts/delegate/_common.sh` `load_env_chain`) — **KHÔNG in giá trị**, chỉ tên biến. Tương thích cả zsh lẫn bash (không dùng `${!v}` bash-only):

```bash
cd "$(git rev-parse --show-toplevel)"
for k in DEEPSEEK_MODEL DEEPSEEK_API_KEY PROXY_9ROUTER_TOKEN PROXY_9ROUTER_BASE_URL; do
  if grep -qE "^${k}=.+" .env.local 2>/dev/null || grep -qE "^${k}=.+" .env 2>/dev/null; then
    echo "$k: set"
  else
    echo "$k: (unset)"
  fi
done
```

Bước 2 — cập nhật Aider qua Homebrew:

```bash
command -v brew >/dev/null && brew upgrade aider 2>&1 | tail -n 10 || echo "brew không có — cập nhật qua pipx/pip nếu áp dụng"
echo "sau update: $(aider --version 2>&1 | head -1)"
```

Bước 3 — (tuỳ chọn) kiểm tra proxy/endpoint DeepSeek reachable. Chỉ lấy HTTP status code, không bao giờ echo URL/token:

```bash
cd "$(git rev-parse --show-toplevel)"
url="$(grep -E '^PROXY_9ROUTER_BASE_URL=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" | tr -d '\r')"
if [ -n "$url" ]; then
  curl -s -o /dev/null -w "proxy status: %{http_code}\n" "$url"
else
  echo "PROXY_9ROUTER_BASE_URL chưa set — wrapper sẽ dùng endpoint DeepSeek trực tiếp (mặc định của aider/LiteLLM), bỏ qua check reachability"
fi
```

Status 200/401/404 đều coi là "reachable" (server trả lời); timeout/000 mới là vấn đề mạng thật sự.

Báo cáo: version aider trước → sau, env var nào đã set (chỉ tên, không giá trị), kết quả reachability. Worktree `delegate-deepseek` đang chạy dở (nếu có) không bị ảnh hưởng — Aider chỉ ảnh hưởng lần gọi kế tiếp.

Sự cố riêng deepseek:
- `brew upgrade aider` fail dependency conflict → báo lỗi brew nguyên văn, không tự `brew reinstall`/`--force`.
- Muốn auto-upgrade định kỳ như các CLI khác → có thể tạo agent mới theo cùng pattern (LaunchAgent trên macOS, cron/systemd timer trên Linux) — KHÔNG tự tạo trong skill này, chỉ gợi ý, để user quyết.
- Reachability trả `000`/timeout → có thể do IPv6 blackhole đã note trong `scripts/delegate/lib/sitecustomize.py` (wrapper aider tự ép AF_INET) — không phải lỗi cấu hình endpoint. Endpoint DeepSeek trực tiếp không có script check sẵn — nếu cần, tự curl HTTP status code, không in URL/token.
- Nghi ngờ model DeepSeek đổi tên/deprecated → không tự đổi `DEEPSEEK_MODEL` trong `.env`, báo user để họ quyết định giá trị mới.

## Xử lý sự cố chung

- Agent auto-upgrade không thấy trong listing → nếu có plist cũ, load lại: `launchctl load ~/Library/LaunchAgents/<label>.plist` (label lấy từ tên file thực tế trong thư mục đó, macOS only). Linux dùng `systemctl --user enable --now <timer>` hoặc thêm dòng crontab tương ứng. (codex: việc này do user/main quyết, subagent không tự load.)
- Log brew báo lỗi (không phải "already installed") → hiện lỗi cho user, KHÔNG tự sửa agent/plist.
- Lệnh update fail → báo lỗi ngắn gọn (bản chất + nguồn), không dán log dài.
