#!/usr/bin/env python3
"""Create a separate Sub-boss workspace; never overwrite existing files."""
import argparse
import json
from pathlib import Path
import shutil
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--projects', required=True, type=Path)
    parser.add_argument('--dest', required=True, type=Path)
    parser.add_argument('--port', type=int, default=4317)
    parser.add_argument('--include-codex-catalog', action='store_true')
    args = parser.parse_args()
    root, dest = args.projects.expanduser().resolve(), args.dest.expanduser().resolve()
    if not root.is_dir():
        parser.error('--projects must be an existing directory')
    if not 1024 <= args.port <= 65535:
        parser.error('--port must be between 1024 and 65535')
    if dest == root or root.is_relative_to(dest):
        parser.error('--dest must not equal or contain the project root')
    if args.dest.is_symlink() or (dest.exists() and (not dest.is_dir() or any(dest.iterdir()))):
        parser.error('--dest must be absent or empty; existing work will not be overwritten')
    source = Path(__file__).resolve().parents[1] / 'assets' / 'workspace'
    shutil.copytree(source, dest, dirs_exist_ok=True)
    (dest / '.gitignore.template').replace(dest / '.gitignore')
    config_dir = dest / '.subboss'
    config_dir.mkdir(mode=0o700)
    config = dict(version=1, projectRoot=str(root), port=args.port,
                  includeCodexCatalog=args.include_codex_catalog)
    (config_dir / 'config.json').write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
    print(f'Created: {dest}')
    print(f'Scan: python3 "{dest / "scripts/scan_projects.py"}" --dashboard')
    print(f'Start: bash "{dest / "scripts/start_dashboard.sh"}"')
    print(f'URL: http://127.0.0.1:{args.port}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
