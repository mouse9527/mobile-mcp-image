"""Static checks of the usage guide (guide/*.md), no docker needed.   usage: guide_check.py <guide dir>
- core.md exists; file names are <a-z0-9->.md (app-<id>.md becomes topic app:<id>); every file starts with a '# ' title
- numbers the gateway owns are never written out: no bare 120 / 600 (lease timings); write {{LEASE_IDLE_S}},
  {{LEASE_HOLD_MAX_S}}, {{LEASE_WAIT_S}} instead, which the gateway fills from its settings
- no unknown {{placeholder}}"""
import pathlib, re, sys

KNOWN = {'LEASE_IDLE_S', 'LEASE_HOLD_MAX_S', 'LEASE_WAIT_S'}
BARE = re.compile(r'(?<![\d.])(?:120|600)(?![\d.])')
d = pathlib.Path(sys.argv[1])
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
        if BARE.search(line):
            errors.append(f'{p.name}:{n}: bare 120 / 600 (use a {{{{LEASE_...}}}} placeholder)')
        for k in re.findall(r'\{\{(\w+)\}\}', line):
            if k not in KNOWN:
                errors.append(f'{p.name}:{n}: unknown placeholder {k}')
for e in errors:
    print('FAIL:', e)
print(f'guide: {len(files)} files, {len(errors)} problem(s)')
sys.exit(1 if errors else 0)
