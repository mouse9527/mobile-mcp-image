#!/usr/bin/env python3
"""Public repository rules (CI and scripts/preflight.sh; stdlib only):

  - no symlinks anywhere
  - generic personal-data rules (policy/rules.py) on every file; binary files are refused (cannot be checked)

The private term list is NOT used here (CI must never have it): passing this is not the private check, which is
scripts/pii_scan.py, run by scripts/preflight.sh before every push. Output names file / line / kind only.

    python3 scripts/validate.py [--root DIR]
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from policy import rules  # noqa: E402

SKIP_DIRS = {'.git', '__pycache__', '.pytest_cache', 'node_modules', 'audit'}
SKIP_FILES = {'.DS_Store'}


def repo_files(root: Path) -> list[Path]:
    out = []
    for d, dirs, files in os.walk(root):
        out += [Path(d) / x for x in dirs if (Path(d) / x).is_symlink()]
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS and not (Path(d) / x).is_symlink())
        out += [Path(d) / f for f in sorted(files) if f not in SKIP_FILES]
    return out


def check_files(root: Path, errors: list[str]) -> int:
    n = 0
    for p in repo_files(root):
        rel = p.relative_to(root).as_posix()
        if p.is_symlink():
            errors.append(f'{rel}: symlink (not allowed)')
            continue
        try:
            text = p.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            errors.append(f'{rel}: binary file (cannot be checked for personal data)')
            continue
        n += 1
        errors += [f'personal data: {f}' for f in rules.scan_text(rel, text)]
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=str(Path(__file__).resolve().parent.parent))
    a = ap.parse_args()
    errors: list[str] = []
    n = check_files(Path(a.root), errors)
    for e in errors:
        print(e)
    print(f'validate: {n} files, {len(errors)} problem(s)')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
