#!/usr/bin/env python3
"""Install the bundled Skill without replacing existing user files."""
import argparse
import os
from pathlib import Path
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--skills-dir', type=Path, default=Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'skills')
args = parser.parse_args()
source = Path(__file__).resolve().parents[1] / 'skills' / 'sub-boss'
target = args.skills_dir.expanduser().resolve() / 'sub-boss'
if target.exists() or target.is_symlink():
    parser.error(f'Already exists, not overwritten: {target}')
shutil.copytree(source, target, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
print(f'Installed: {target}')
print('Open a new Codex conversation and invoke $sub-boss.')
