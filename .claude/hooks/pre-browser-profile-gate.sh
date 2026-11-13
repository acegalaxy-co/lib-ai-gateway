#!/usr/bin/env bash
# PreToolUse hook — enforce browser profile isolation (Cloak + Playwright).
# Wired to matchers: MCP browser tools (mcp__pw_*, mcp__cloak*, mcp__playwright*)
# + Bash (catch direct `@playwright/mcp` / cloak launch).
#
# Rule: .claude/rules/project/browser-mcp-profiles.md
#   Mọi action Cloak/Playwright PHẢI gắn 1 profile prj_<xx>_sv_<yy> trong container.
#   - MCP: server name = <pw|cloak>_<xx>_<yy>. Cloak launch phải truyền đúng
#     user_data_dir=.../prj_<xx>_sv_<yy>; Playwright bake profile vào server entry.
#   - Bash Playwright launch: phải có --user-data-dir=.../prj_<xx>_sv_<yy> → thiếu = BLOCK.
#
# THREAT MODEL: chống tạo profile tùm lum vô ý (default cache, tên bừa), KHÔNG chống
# adversary — name/command heuristic, không sandbox.
#
# Output: exit 0 = allow · exit 2 = block (stderr shown to model).
# Fail-open: thiếu jq / payload không JSON → allow.
set -euo pipefail

# harness off-switch
[ "${HARNESS_DELEGATE:-1}" = "0" ] && exit 0

# Profile naming: server key <pw|cloak>_<xx>_<yy>; dir prj_<xx>_sv_<yy>.
RE_SERVER='^(pw|cloak)_[a-z0-9]+_[a-z0-9]+$'
RE_PROFILE='prj_[a-z0-9]+_sv_[a-z0-9]+'

# Container luôn là <repo>/.browser-profiles — KHÔNG override bằng env
# (env toàn cục sẽ dồn profile mọi project về chung 1 repo).
profile_root() {
  [[ -n "${CLAUDE_PROJECT_DIR:-}" ]] || return 1
  local base="${CLAUDE_PROJECT_DIR%/}" common
  # Worktree → resolve về root checkout chính (container dùng chung, không tạo riêng mỗi worktree).
  common=$(git -C "$base" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || common=""
  [[ "$common" == */.git ]] && base="${common%/.git}"
  local root="$base/.browser-profiles"
  [[ "$root" == /* ]] || return 1
  printf '%s' "${root%/}"
}

# Hub (_hub: có repo-router.sh) điều phối nhiều repo → CLAUDE_PROJECT_DIR không phải repo đích.
is_hub() { [[ -n "${CLAUDE_PROJECT_DIR:-}" && -f "${CLAUDE_PROJECT_DIR%/}/.claude/hooks/repo-router.sh" ]]; }

# cmd_repo <cmd> → repo đích từ tiền tố `cd <abs>` / `git -C <abs>` (quy ước hub); worktree → checkout chính.
cmd_repo() {
  local d common
  [[ "$1" =~ (^|[\;\&\|[:space:]])(cd|-C)[[:space:]]+[\"\']?(/[^\"\'[:space:]\;\&\|]+) ]] || return 1
  d="${BASH_REMATCH[3]%/}"
  common=$(git -C "$d" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || common=""
  if [[ "$common" == */.git ]]; then d="${common%/.git}"
  else d=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$d"); fi
  printf '%s' "${d%/}"
}

# Profile ngoài repo đã duyệt — 1 path tuyệt đối / dòng.
ALLOW_EXTRA_FILE="${HOME}/.claude/hooks/browser-profiles-allow.txt"

# valid_profile_dir <dir> <expected> [cmd]
#  - session repo: đúng <repo>/.browser-profiles/<expected>.
#  - session hub: repo từ `cd <repo>` trong cmd; không có → container của bất kỳ repo
#    (<abs>/.browser-profiles/<expected>, không trong .worktrees, không /tmp).
#  - path trong browser-profiles-allow.txt.
valid_profile_dir() {
  local user_data_dir="$1" expected="$2" cmd="${3:-}" root repo
  [[ "$user_data_dir" == /* ]] || return 1
  [[ "${user_data_dir##*/}" == "$expected" ]] || return 1
  [[ -f "$ALLOW_EXTRA_FILE" ]] && grep -qxF "$user_data_dir" "$ALLOW_EXTRA_FILE" && return 0
  if is_hub; then
    if repo=$(cmd_repo "$cmd"); then
      [[ "$user_data_dir" == "$repo/.browser-profiles/$expected" ]]; return
    fi
    [[ "$user_data_dir" == */.browser-profiles/"$expected" && "$user_data_dir" != */.worktrees/* \
       && "$user_data_dir" != /tmp/* && "$user_data_dir" != /private/tmp/* ]]; return
  fi
  root="$(profile_root)" || return 1
  [[ "$user_data_dir" == "$root/$expected" ]]
}

msg_block() {
  cat >&2 << EOF
🚦 browser-profile-gate: action Cloak/Playwright thiếu profile hợp lệ — BLOCK.
   $1

   Rule: .claude/rules/project/browser-mcp-profiles.md (GATE P0)
     • MCP server phải đặt tên <pw|cloak>_<xx>_<yy> (1 entry / profile).
     • Cloak launch phải truyền user_data_dir=<container>/prj_<xx>_sv_<yy> khớp server;
       Playwright server phải bake --user-data-dir vào entry.
     • KHÔNG dùng server generic hay launch thiếu profile (rơi default/ephemeral).
   Tạo/chọn profile prj_<xx>_sv_<yy> rồi thao tác lại.
EOF
}

# launches_playwright_mcp <cmd> → 0 nếu có segment THỰC SỰ chạy Playwright MCP.
# Tách command theo ; | & ( ) ` newline; mỗi segment bỏ prefix (env VAR=, sudo, env,
# exec, nohup, time, command) rồi xét từ đầu: launcher (npx/bunx/pnpx/node/deno,
# npm exec, pnpm dlx|exec, yarn dlx, bun x|run, binary playwright-mcp /
# mcp-server-playwright) hoặc shell wrapper (bash/sh/zsh/eval/xargs — mơ hồ → giữ
# strict) VÀ segment chứa @playwright/mcp | playwright.*mcp. Text-only (grep, cat,
# git commit -m, jq, npm ls/install...) chỉ nhắc tên → không phải launch → pass.
launches_playwright_mcp() {
  local seg w1 w2 word
  local -a toks
  while IFS= read -r seg; do
    echo "$seg" | grep -Eq '@playwright/mcp|playwright.*mcp|mcp.*playwright' || continue
    read -ra toks <<< "$seg" || true
    w1=""; w2=""
    for word in "${toks[@]+"${toks[@]}"}"; do
      case "$word" in
        [A-Za-z_]*=*|sudo|env|exec|nohup|time|command) continue ;;
      esac
      if [ -z "$w1" ]; then w1="${word##*/}"; else w2="$word"; break; fi
    done
    case "$w1" in
      npx|bunx|pnpx|node|deno|docker|podman|uvx|pipx|playwright-mcp|mcp-server-playwright|bash|sh|zsh|dash|eval|xargs) return 0 ;;
      python|python3) [[ "$w2" == "-" || "$w2" == "-c" || "$w2" == *.py || "$w2" == *.sh ]] || return 0 ;;
      npm)  [ "$w2" = exec ] && return 0 ;;
      pnpm) { [ "$w2" = dlx ] || [ "$w2" = exec ]; } && return 0 ;;
      yarn) [ "$w2" = dlx ] && return 0 ;;
      bun)  { [ "$w2" = x ] || [ "$w2" = run ]; } && return 0 ;;
    esac
  done < <(printf '%s\n' "$1" | sed -E 's/[;|&()`]/\n/g')
  return 1
}

# real_input <cmd> → 0 nếu có segment điều khiển chuột/phím THẬT (cướp input của dev).
# Rule: ~/.claude/CLAUDE.md "Browser tự động" — chỉ dùng chuột/phím ảo (CDP/Playwright).
real_input() {
  local seg
  while IFS= read -r seg; do
    seg="${seg#"${seg%%[![:space:]]*}"}"
    # cliclick phải kèm action (c:, kp:, t:...) — chữ "cliclick" trơn trong text/heredoc không chặn.
    echo "$seg" | grep -Eq '^([^[:space:]]*/)?cliclick([[:space:]]+-[^[:space:]]+([[:space:]]+[0-9]+)?)*[[:space:]]+(c|dc|rc|tc|m|dd|du|dm|kd|ku|kp|t|w):' && return 0
    case "$seg" in
      osascript*) echo "$seg" | grep -Eqi 'System Events.*(keystroke|key code|click)' && return 0 ;;
      xdotool\ *|ydotool\ *) return 0 ;;
    esac
  done < <(printf '%s\n' "$1" | sed -E 's/[;|&()`]/\n/g')
  return 1
}

# headed_launch <cmd> → 0 nếu launch browser CÓ CỬA SỔ không có lý do manual.
# Bắt buộc headless; headed chỉ khi user thao tác tay → prefix ACE_HEADED=manual.
# poll_tab_loop <cmd> → 0 nếu vòng while/for+sleep chạy script mở tab mới vào Chrome qua CDP.
# Mỗi vòng newPage/createTarget trên Chrome có cửa sổ = Chrome giành focus (sự cố 11-08: poll
# ipinfo 30s/lần trên Chrome VPN 9334). Poll phải dùng 1 tab cố định (Runtime.evaluate fetch).
poll_tab_loop() {
  local cmd="$1" f
  grep -Eq '(^|[;&|[:space:]])(while|for|until)[[:space:]]' <<<"$cmd" && grep -Eq '(^|[;&|[:space:]])sleep[[:space:]]' <<<"$cmd" || return 1
  grep -Eq 'connectOverCDP|remote-debugging|:9[0-9]{3}' <<<"$cmd" && grep -Eq 'newPage|createTarget' <<<"$cmd" && return 0
  for f in $(grep -oE '(node|python3?|tsx)[[:space:]]+[^[:space:];|&]+\.(mjs|cjs|js|ts|py)' <<<"$cmd" | awk '{print $2}'); do
    [[ -f "$f" ]] && grep -Eq 'connectOverCDP|connect_over_cdp' "$f" && grep -Eq 'newPage|new_page|createTarget' "$f" && return 0
  done
  return 1
}

headed_launch() {
  local cmd="$1"
  # Chrome thô headed + CDP: kể cả ACE_HEADED=manual — nohup/open không -g giành focus, cửa sổ
  # nằm trên màn hình (sự cố 11-08 Chrome VPN 9334). Phải qua chrome-bg.sh (open -g + offscreen).
  if echo "$cmd" | grep -Eq '(Google\\? Chrome|[Cc]hrom(e|ium))[^;|&]*--remote-debugging-(port|pipe)' \
     && ! echo "$cmd" | grep -Eq -- '--headless'; then
    HEADED_REASON=raw-cdp; return 0
  fi
  [[ "$cmd" == *ACE_HEADED=manual* ]] && return 1
  if launches_playwright_mcp "$cmd"; then
    [[ "$cmd" == *--headless* ]] || return 0
  fi
  # script/test chạy headed qua cờ/env (--headless=false, --headed, HEADLESS=0|false)
  echo "$cmd" | grep -Eq -- '--headless[= ](false|0)([^[:alnum:]]|$)|(^|[[:space:]])--headed([^[:alnum:]-]|$)|(^|[[:space:]])HEADLESS=(0|false)([^[:alnum:]]|$)' && return 0
  # Chrome/Chromium thô mở CDP
  if echo "$cmd" | grep -Eq '(Google\\? Chrome|[Cc]hrom(e|ium))[^;|&]*--remote-debugging-(port|pipe)'; then
    echo "$cmd" | grep -Eq -- '--headless' || return 0
  fi
  return 1
}

# script_violation <content> → lý do nếu code MỚI mở browser headed cứng / input thật.
# headed hợp lệ = có cổng manual: ghi chú `ace-headed: manual` hoặc lấy từ env/cờ.
script_violation() {
  local c="$1"
  if grep -Eq '(robotjs|@nut-tree|pyautogui|pynput|from[[:space:]]+Quartz|CGEventPost)' <<<"$c"; then
    echo "chuột/phím thật (robotjs/nut-tree/pyautogui/pynput/CGEvent) — dùng CDP Input.dispatch* / Playwright."; return
  fi
  if grep -Eq 'System Events.*(keystroke|key code|click)|cliclick.*[[:space:]"'"'"'](c|kp|t|dc|rc):|xdotool[[:space:]]+(click|key|type|mousemove)' <<<"$c"; then
    echo "script gọi osascript System Events / cliclick / xdotool — dùng chuột/phím ảo."; return
  fi
  if grep -Eq 'headless["'"'"']?[[:space:]]*[:=][[:space:]]*(false|False)([^[:alnum:]_]|$)' <<<"$c"; then
    grep -Eq 'ace-headed: manual|process\.env|os\.environ|getenv|argv|opts?\.headless|options\.headless' <<<"$c" && return
    echo "browser headed cứng (headless: false) — mặc định PHẢI headless; headed chỉ qua cổng manual (env/cờ) hoặc ghi chú '// ace-headed: manual <lý do login/captcha>'."; return
  fi
}

# verdict <tool_name> <cmd> <user_data_dir> → ALLOW hoặc "BLOCK:<reason>"
verdict() {
  local tool="$1" cmd="${2:-}" user_data_dir="${3:-}" server expected

  # ── MCP browser tool ────────────────────────────────────────────────
  if [[ "$tool" == mcp__* ]]; then
    server="${tool#mcp__}"; server="${server%%__*}"
    # chỉ quan tâm server browser
    case "$server" in
      pw_*|cloak_*|cloak|playwright|browser|*[Bb]rowser*)
        if ! [[ "$server" =~ $RE_SERVER ]]; then
          echo "BLOCK:MCP server '$server' chưa scope profile (đặt tên <pw|cloak>_<xx>_<yy>)."
          return
        fi
        if [[ "$server" == cloak_* && "$tool" == *"__cloak_launch" ]]; then
          local pair="${server#cloak_}" xx yy
          xx="${pair%%_*}"; yy="${pair#*_}"
          expected="prj_${xx}_sv_${yy}"
          if ! valid_profile_dir "$user_data_dir" "$expected"; then
            echo "BLOCK:cloak_launch trên '$server' phải truyền user_data_dir=<container>/$expected, đúng container đã resolve."

          else
            echo ALLOW
          fi
        else
          echo ALLOW
        fi
        ;;
      *) echo ALLOW ;;  # MCP non-browser (notion...) — không đụng
    esac
    return
  fi

  # ── Edit/Write script: headed cứng / input thật ──
  if [[ "$tool" =~ ^(Edit|Write|MultiEdit)$ ]]; then
    local r; r=$(script_violation "$cmd")
    if [[ -n "$r" ]]; then echo "BLOCK:$r"; else echo ALLOW; fi
    return
  fi

  # ── Bash launch Playwright MCP ──────────────────────────────────────
  # Cloak không bind profile qua CLI; gate nó tại tool cloak_launch ở trên.
  if [ "$tool" = "Bash" ] && [ -n "$cmd" ]; then
    if poll_tab_loop "$cmd"; then
      echo "BLOCK:vòng lặp mở tab mới (newPage/createTarget) vào Chrome qua CDP mỗi lượt → Chrome giành focus mỗi lần. Poll bằng 1 tab cố định: mở 1 lần ngoài vòng, mỗi lượt Runtime.evaluate/page.evaluate(fetch(...)); hoặc curl qua proxy thay vì browser."
      return
    fi
    if real_input "$cmd"; then
      echo "BLOCK:chuột/phím thật (cliclick / osascript System Events) — dùng chuột/phím ảo CDP Input.dispatch* / Playwright click/keyboard."
      return
    fi
    HEADED_REASON=
    if headed_launch "$cmd"; then
      [[ "$HEADED_REASON" == raw-cdp ]] && { echo "BLOCK:Chrome headed + --remote-debugging mở thô sẽ giành focus và nằm trên màn hình. Dùng --headless=new; cần cửa sổ (extension VPN/site chặn headless) → bash ~/.claude/hooks/chrome-bg.sh <repo>/.browser-profiles/prj_<xx>_sv_<yy> <port> (open -g + đẩy offscreen; --manual khi user cần thao tác tay)."; return; }
      echo "BLOCK:browser phải headless (--headless / --headless=new). Headed CHỈ khi cần user thao tác tay (login/captcha/2FA): prefix ACE_HEADED=manual, xong quay lại headless."
      return
    fi
    if launches_playwright_mcp "$cmd"; then
      # phải có --user-data-dir=...prj_<xx>_sv_<yy>
      if [[ "$cmd" =~ --user-data-dir=([^[:space:]]+) ]] && valid_profile_dir "${BASH_REMATCH[1]}" "${BASH_REMATCH[1]##*/}" "$cmd" && [[ "${BASH_REMATCH[1]##*/}" =~ ^$RE_PROFILE$ ]]; then
        echo ALLOW
      else
        echo "BLOCK:launch Playwright MCP phải có --user-data-dir=<container>/prj_<xx>_sv_<yy>."
      fi
      return
    fi
  fi

  echo ALLOW
}

# ── self-test ───────────────────────────────────────────────────────────
if [ "${1:-}" = "--self-test" ]; then
  CLAUDE_PROJECT_DIR=/repo
  export CLAUDE_PROJECT_DIR
  BROWSER_PROFILES_DIR=/elsewhere   # env toàn cục phải bị bỏ qua
  export BROWSER_PROFILES_DIR
  fail=0
  check() { # check <expect-prefix> <tool> <cmd> <user_data_dir>
    local got; got=$(verdict "$2" "${3:-}" "${4:-}")
    case "$got" in
      "$1"*) ;;
      *) echo "FAIL: verdict($2,'${3:-}')='$got' expected '$1*'"; fail=1 ;;
    esac
  }
  check ALLOW  "mcp__pw_myapp_auth__browser_navigate"
  check ALLOW  "mcp__cloak_shop_checkout__click"
  check BLOCK  "mcp__cloak_shop_checkout__cloak_launch"
  check BLOCK  "mcp__cloak_shop_checkout__cloak_launch" "" "/repo/.browser-profiles/prj_shop_sv_other"
  check ALLOW  "mcp__cloak_shop_checkout__cloak_launch" "" "/repo/.browser-profiles/prj_shop_sv_checkout"
  check BLOCK  "mcp__cloak_shop_checkout__cloak_launch" "" "relative/prj_shop_sv_checkout"
  check BLOCK  "mcp__cloak_shop_checkout__cloak_launch" "" "/tmp/prj_shop_sv_checkout"
  check BLOCK  "mcp__cloak_shop_checkout__cloak_launch" "" "/repo/.browser-profiles/prj_shop_sv_checkout/extra"
  check BLOCK  "mcp__playwright__browser_navigate"
  check BLOCK  "mcp__cloak__click"
  check BLOCK  "mcp__pw_myapp__navigate"           # thiếu _yy
  check ALLOW  "mcp__claude_ai_Notion__notion-search"  # non-browser MCP
  check ALLOW  "Bash" "npx -y @playwright/mcp --headless --user-data-dir=/repo/.browser-profiles/prj_myapp_sv_auth"
  check BLOCK  "Bash" "npx -y @playwright/mcp --user-data-dir=/repo/.browser-profiles/prj_myapp_sv_auth"   # headed
  check ALLOW  "Bash" "ACE_HEADED=manual npx -y @playwright/mcp --user-data-dir=/repo/.browser-profiles/prj_myapp_sv_auth"
  check BLOCK  "Bash" "'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --remote-debugging-port=9222 --user-data-dir=/tmp/x"
  check ALLOW  "Bash" "'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --headless=new --remote-debugging-port=9222"
  check BLOCK  "Bash" "ACE_HEADED=manual nohup \"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\" --user-data-dir=/r/.browser-profiles/prj_a_sv_vpn --remote-debugging-port=9334 about:blank &"
  check BLOCK  "Bash" "ACE_HEADED=manual nohup /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9334 &"
  mkdir -p /tmp/gate-st && printf '%s\n' "const b = await chromium.connectOverCDP('http://127.0.0.1:9334'); const p = await b.contexts()[0].newPage();" > /tmp/gate-st/ip.mjs
  check BLOCK  "Bash" "while [ \$SECONDS -lt \$end ]; do c=\$(node /tmp/gate-st/ip.mjs); sleep 30; done"
  check ALLOW  "Bash" "node /tmp/gate-st/ip.mjs"
  check ALLOW  "Bash" "for f in a b; do echo \$f; sleep 1; done"
  check ALLOW  "Bash" "bash ~/.claude/hooks/chrome-bg.sh /r/.browser-profiles/prj_a_sv_vpn 9334"
  check BLOCK  "Bash" "xdotool click 1"
  check ALLOW  "Bash" "grep -rn xdotool ."
  check BLOCK  "Bash" "npx -y @playwright/mcp --user-data-dir=/tmp/prj_myapp_sv_auth"
  check BLOCK  "Bash" "npx -y @playwright/mcp --user-data-dir=/elsewhere/prj_myapp_sv_auth"  # env override không còn hiệu lực
  check BLOCK  "mcp__cloak_shop_checkout__cloak_launch" "" "/elsewhere/prj_shop_sv_checkout"
  check BLOCK  "Bash" "npx -y @playwright/mcp --user-data-dir=relative/prj_myapp_sv_auth"
  check BLOCK  "Bash" "npx -y @playwright/mcp --headless"
  check BLOCK  "Bash" "npx -y @playwright/mcp --user-data-dir=/tmp/scratch"  # tên không phải prj_
  check ALLOW  "Bash" "git commit -m 'configure cloak per repo'" # không phải browser launch
  check ALLOW  "Bash" "grep -rn playwright ."       # chỉ nhắc tên
  check ALLOW  "Bash" "git commit -m 'playwright mcp notes'"
  check BLOCK  "Bash" "FOO=1 npx @playwright/mcp"
  check BLOCK  "Bash" "cliclick c:100,200"
  check BLOCK  "Bash" "sleep 1; /opt/homebrew/bin/cliclick kp:return"
  check BLOCK  "Bash" "osascript -e 'tell application \"System Events\" to keystroke \"a\"'"
  check ALLOW  "Bash" "osascript -e 'display notification \"done\"'"
  check ALLOW  "Bash" "grep -rn cliclick ."
  check ALLOW  "Bash" 'python3 - <<EOF
L="KHÔNG `cliclick`, `osascript`"
EOF'
  check BLOCK  "Bash" "cliclick -w 50 kp:return"
  check BLOCK  "Bash" "node tools/smoke.mjs --headless=false"
  check BLOCK  "Bash" "npx playwright test --headed"
  check BLOCK  "Bash" "HEADLESS=0 node probe.mjs"
  check ALLOW  "Bash" "ACE_HEADED=manual node login.mjs --headless=false"
  check ALLOW  "Bash" "python3 - <<'X'
s='npx @playwright/mcp'
X"
  check ALLOW  "Bash" "python3 /tmp/patch.py"
  check BLOCK  "Write" "const b = await chromium.launch({ headless: false })"
  check BLOCK  "Write" "browser = p.chromium.launch(headless=False)"
  check ALLOW  "Write" "const b = await chromium.launch({ headless: process.env.ACE_HEADED !== 'manual' })"
  check ALLOW  "Write" "launch({ headless: false }) // ace-headed: manual login FB 2FA"
  check ALLOW  "Write" "const b = await chromium.launch({ headless: true })"
  check BLOCK  "Write" "import robot from 'robotjs'"
  check BLOCK  "Write" "import pyautogui"
  check BLOCK  "Write" "execSync('xdotool click 1')"
  HUB=$(mktemp -d); mkdir -p "$HUB/.claude/hooks"; touch "$HUB/.claude/hooks/repo-router.sh"
  CLAUDE_PROJECT_DIR=$HUB
  check ALLOW  "mcp__cloak_shop_checkout__cloak_launch" "" "/other/repo/.browser-profiles/prj_shop_sv_checkout"
  check BLOCK  "mcp__cloak_shop_checkout__cloak_launch" "" "/tmp/x/.browser-profiles/prj_shop_sv_checkout"
  check BLOCK  "mcp__cloak_shop_checkout__cloak_launch" "" "/r/.worktrees/a/.browser-profiles/prj_shop_sv_checkout"
  check BLOCK  "mcp__cloak_shop_checkout__cloak_launch" "" "/r/a/.browser-profiles/prj_shop_sv_other"
  check ALLOW  "Bash" "cd /r/a && npx -y @playwright/mcp --headless --user-data-dir=/r/a/.browser-profiles/prj_a_sv_b"
  check BLOCK  "Bash" "cd /r/a && npx -y @playwright/mcp --headless --user-data-dir=/r/b/.browser-profiles/prj_b_sv_c"
  check ALLOW  "Bash" "npx -y @playwright/mcp --headless --user-data-dir=/r/b/.browser-profiles/prj_b_sv_c"
  rm -rf "$HUB"; CLAUDE_PROJECT_DIR=/repo
  check ALLOW  "Bash" "ls -la"                    # bash thường
  [ "$fail" = 0 ] && echo "self-test PASS" || { echo "self-test FAIL"; exit 1; }
  exit 0
fi

# ── main ────────────────────────────────────────────────────────────────
command -v jq >/dev/null 2>&1 || exit 0
payload=$(cat)
printf '%s' "$payload" | jq empty >/dev/null 2>&1 || exit 0

tool=$(echo "$payload" | jq -r '.tool_name // empty')
cmd=$(echo "$payload"  | jq -r '.tool_input.command // empty')
user_data_dir=$(echo "$payload" | jq -r '.tool_input.user_data_dir // empty')
[ -z "$tool" ] && exit 0
if [[ "$tool" =~ ^(Edit|Write|MultiEdit)$ ]]; then
  f=$(echo "$payload" | jq -r '.tool_input.file_path // empty')
  [[ "$f" =~ \.(mjs|cjs|js|ts|py|sh)$ && "$f" != */node_modules/* && "$f" != */.claude/hooks/* ]] || exit 0
  cmd=$(echo "$payload" | jq -r '[.tool_input.content, .tool_input.new_string, (.tool_input.edits // [] | .[].new_string)] | map(select(.)) | join("\n")')
fi

res=$(verdict "$tool" "$cmd" "$user_data_dir")
if [[ "$res" == BLOCK:* ]]; then
  msg_block "${res#BLOCK:}"
  exit 2
fi
exit 0
