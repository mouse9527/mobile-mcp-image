"""Static checks of the usage guide (guide/*.md), no docker needed.
    guide_check.py <guide dir>      check the guide
    guide_check.py --self-test      check the checker (samples that must / must not be flagged)
- core.md exists; file names are <a-z0-9->.md (app-<id>.md becomes topic app:<id>); every file starts with a '# ' title
- lease timings are never written out: the gateway owns them. A bare 120 / 600 is refused where it reads as a lease
  time — followed by a time unit (秒 / 分钟 / s / sec), or on a line about occupying / holding / releasing / queueing
  for the phone. Write {{LEASE_IDLE_S}}, {{LEASE_HOLD_MAX_S}}, {{LEASE_WAIT_S}}, {{LEASE_SESSION_FIRST_IDLE_S}} instead,
  which the gateway fills from its settings. Other numbers (「满 120 元」, 120Hz) are fine.
- no unknown {{placeholder}}"""
import pathlib, re, sys

KNOWN = {'LEASE_IDLE_S', 'LEASE_HOLD_MAX_S', 'LEASE_WAIT_S', 'LEASE_SESSION_FIRST_IDLE_S'}
LEASE_NUM = r'(?<![\d.])(?:120|600)(?![\d.])'
# a lease number followed by a time unit, or anywhere on a line about the lease
BARE_TIME = re.compile(LEASE_NUM + r'\s*(?:秒|分钟|s\b|sec|second)', re.I)
BARE_ANY = re.compile(LEASE_NUM)
LEASE_LINE = re.compile(r'占用|保留|释放|排队|租约|lease|hold', re.I)


def bare_lease_number(line: str) -> bool:
    return bool(BARE_TIME.search(line) or (BARE_ANY.search(line) and LEASE_LINE.search(line)))


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
    flagged = ['最多 600 秒', '占用保持约 120 秒', '保留 120', 'lease_hold 600', 'hold up to 120s', '等 600 sec']
    clean = ['满 120 元减 20', '120Hz 屏幕', '¥600 的耳机', '约 {{LEASE_IDLE_S}} 秒', '1200 秒', '6000 元', '120.5 km']
    errors = [f'self-test: not flagged: {s}' for s in flagged if not bare_lease_number(s)]
    errors += [f'self-test: flagged by mistake: {s}' for s in clean if bare_lease_number(s)]
    print(f'guide_check self-test: {len(flagged) + len(clean)} samples, {len(errors)} problem(s)')
    return errors


errors = self_test() if sys.argv[1:] == ['--self-test'] else check(pathlib.Path(sys.argv[1]))
for e in errors:
    print('FAIL:', e)
sys.exit(1 if errors else 0)
