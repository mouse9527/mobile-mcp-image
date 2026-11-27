"""Static checks of the usage guide (guide/*.md), no docker needed.
    guide_check.py <guide dir>      check the guide
    guide_check.py --self-test      check the checker (samples that must / must not be flagged)
- core.md exists; file names are <a-z0-9->.md (app-<id>.md becomes topic app:<id>); every file starts with a '# ' title
- lease timings are never written out: the gateway owns them. Every bare 120 / 600 is refused (with or without a
  unit: 「最多 600」 is a lease time too) unless the text right next to that number says it is something else: a
  non-time unit after it (元, 件, km, Hz, %, …) or a price word / currency sign just before it (¥, 满, 减, 价, 券).
  Judged per number, not per line: 「排队时满 120 元」 passes, 「手机最多留 120 给同一个任务」 does not. Write
  {{LEASE_IDLE_S}}, {{LEASE_HOLD_MAX_S}}, {{LEASE_WAIT_S}}, {{LEASE_SESSION_FIRST_IDLE_S}} instead, which the gateway
  fills from its settings.
- no unknown {{placeholder}}"""
import pathlib, re, sys

KNOWN = {'LEASE_IDLE_S', 'LEASE_HOLD_MAX_S', 'LEASE_WAIT_S', 'LEASE_SESSION_FIRST_IDLE_S'}
LEASE_NUM = re.compile(r'(?<![\d.])(?:120|600)(?![\d.])')
# what makes a 120 / 600 something other than a time, judged right next to the number: a non-time unit after it ...
OTHER_UNIT_AFTER = re.compile(r'\s*(?:元|块|角|分(?!钟)|件|个|人|份|次|条|张|页|款|家|单|字|行|号|楼|层|平|度|折|帧|斤|克|升|毫升'
                              r'|公里|米|km|cm|mm|m(?![a-z])|hz|gb|mb|kb|mah|ml|kg|g(?![a-z])|w(?![a-z])|px|dpi|fps|%|％|°|㎡)', re.I)
# ... or a currency sign / price word just before it (「¥600」「满 120 减 20」「到手价 600」「券 120」)
OTHER_BEFORE = re.compile(r'(?:[¥￥$]|rmb|满|减|价|券)\s*$', re.I)


def bare_lease_number(line: str) -> bool:
    for m in LEASE_NUM.finditer(line):
        if OTHER_UNIT_AFTER.match(line, m.end()) or OTHER_BEFORE.search(line[max(0, m.start() - 6):m.start()]):
            continue
        return True
    return False


def check(d: pathlib.Path) -> list[str]:
    errors = []
    files = sorted(d.glob('*.md'))
    if not (d / 'core.md').is_file():
        errors.append('core.md missing')
    for p in files:
        if not re.fullmatch(r'[a-z0-9-]+\.md', p.name):
            errors.append(f'{p.name}: file name must be [a-z0-9-].md')
        text = p.read_text(encoding='utf-8')
        if not text.startswith('# '):
            errors.append(f'{p.name}: must start with a "# " title')
        for n, line in enumerate(text.splitlines(), 1):
            if bare_lease_number(line):
                errors.append(f'{p.name}:{n}: bare lease time 120 / 600 (use a {{{{LEASE_...}}}} placeholder)')
            for k in re.findall(r'\{\{(\w+)\}\}', line):
                if k not in KNOWN:
                    errors.append(f'{p.name}:{n}: unknown placeholder {k}')
    print(f'guide: {len(files)} files, {len(errors)} problem(s)')
    return errors


def self_test() -> list[str]:
    flagged = ['最多 600 秒', '占用保持约 120 秒', '保留 120', 'lease_hold 600', 'hold up to 120s', '等 600 sec',
               '手机最多留 120 给同一个任务', '最多 600', '等 120 再试', '满 120 元，最多占用 600']
    clean = ['满 120 元减 20', '120Hz 屏幕', '¥600 的耳机', '约 {{LEASE_IDLE_S}} 秒', '1200 秒', '6000 元', '120.5 km',
             '排队时满 120 元减 20', '满 120 减 20', '到手价 600', '保留 120 次浏览记录', '600 件起批']
    errors = [f'self-test: not flagged: {s}' for s in flagged if not bare_lease_number(s)]
    errors += [f'self-test: flagged by mistake: {s}' for s in clean if bare_lease_number(s)]
    print(f'guide_check self-test: {len(flagged) + len(clean)} samples, {len(errors)} problem(s)')
    return errors


errors = self_test() if sys.argv[1:] == ['--self-test'] else check(pathlib.Path(sys.argv[1]))
for e in errors:
    print('FAIL:', e)
sys.exit(1 if errors else 0)
