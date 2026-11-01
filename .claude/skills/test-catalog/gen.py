"""Generate the full test catalog section into docs/testing.md (run from repo root).
Usage: python3 .claude/skills/test-catalog/gen.py [--check]"""
import glob, os, re, sys

START, END = '<!-- test-catalog:start -->', '<!-- test-catalog:end -->'
SIG = re.compile(r'^\s*(?:public\s+|protected\s+|private\s+)?(?:static\s+)?void\s+(\w+)\s*\(')
TEST_ANN = re.compile(r'@(?:org\.junit\.jupiter\.api\.)?(?:Test|ParameterizedTest|RepeatedTest)\b')


def is_disabled(anns):
    return any(re.match(r'@(?:org\.junit\.jupiter\.api\.)?Disabled\b', a) for a in anns)


def scan():
    """Line-based: '@' lines directly above `void name(` / `class` belong to it (quoted args with parens are fine)."""
    rows = []
    for f in sorted(glob.glob('sources/games/*/src/test/java/**/*.java', recursive=True)):
        tests, anns, cls_disabled = [], [], False
        for line in open(f):
            t = line.strip()
            if t.startswith('@'):
                anns.append(t)
                continue
            m = SIG.match(line)
            if m and any(TEST_ANN.match(a) for a in anns):
                tests.append((m.group(1), is_disabled(anns)))
            elif re.search(r'\bclass\s', t) and is_disabled(anns):
                cls_disabled = True
            if t and not t.startswith(('//', '*', '/*')):
                anns = []
        if tests:
            rows.append((f.split('/')[2], os.path.basename(f)[:-5], tests, cls_disabled))
    return rows


def render(rows):
    total = sum(len(t) for _, _, t, _ in rows)
    dis = sum(1 for _, _, t, cd in rows for _, d in t if d or cd)
    out = [START, '## Danh mục test (toàn bộ)', '',
           f'Sinh tự động từ code: {total} test trong {len(rows)} class, {dis} đang `@Disabled` (đánh dấu **D**, là bug đã biết). '
           'Gồm cả các test đã mô tả ở những mục trên. Thêm/xoá test thì chạy lại `python3 .claude/skills/test-catalog/gen.py`.', '',
           '| Module | Class | Số test | Test case |', '|---|---|---|---|']
    for mod, cls, tests, cd in rows:
        cases = ', '.join(f'`{n}`' + (' **D**' if d or cd else '') for n, d in tests)
        out.append(f'| {mod} | `{cls}` | {len(tests)} | {cases} |')
    out.append(END)
    return '\n'.join(out) + '\n', total, dis


def main():
    rows = scan()
    block, total, dis = render(rows)
    p = 'docs/testing.md'
    s = open(p).read()
    if START in s:
        s = s[:s.index(START)] + block + s[s.index(END) + len(END) + 1:]
    else:
        s = s.replace('## Giới hạn', block + '\n## Giới hạn', 1)
    if '--check' in sys.argv:
        sys.exit(0 if open(p).read() == s else 1)
    open(p, 'w').write(s)
    print(f'classes={len(rows)} tests={total} disabled={dis}')


if __name__ == '__main__':
    main()
