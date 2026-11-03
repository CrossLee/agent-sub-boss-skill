#!/usr/bin/env python3
"""Read immediate project directories; emit a conservative, evidence-based inventory."""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

WORKSPACE = Path(__file__).resolve().parents[1]


def read(path, limit=65536):
    # Do not follow symlinks to outside the selected project or read secrets.
    if path.is_symlink() or not path.is_file():
        return ''
    with path.open(encoding='utf-8', errors='replace') as stream:
        return stream.read(limit)


def section(text, title):
    match = re.search(r'^##\s+' + re.escape(title) + r'\s*\n(.*?)(?=^##\s|\Z)', text, re.M | re.S)
    return match.group(1).strip()[:2000] if match else '未知 / 未维护'


def git(project, *args):
    try:
        return subprocess.run(['git', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
                               '-C', str(project), *args], capture_output=True, text=True,
                              timeout=8, check=True).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, encoding='utf-8', delete=False) as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
        temporary = Path(stream.name)
    temporary.replace(path)


def scan(root):
    rows = []
    for project in sorted(root.iterdir()):
        if project.name.startswith('.') or project.is_symlink() or not project.is_dir() or project.resolve() == WORKSPACE:
            continue
        status = read(project / 'PROJECT_STATUS.md')
        git_root = git(project, 'rev-parse', '--show-toplevel')
        owned_git = bool(git_root) and Path(git_root).resolve() == project.resolve()
        changes = git(project, 'status', '--short') if owned_git else ''
        rows.append(dict(id='project-' + hashlib.sha256(str(project.resolve()).encode()).hexdigest()[:16],
                         name=project.name, path=str(project), phase=section(status, '当前阶段'),
                         progress=section(status, '最近进展'), blockers=section(status, '当前阻塞'),
                         next=section(status, '下一步'), risks=section(status, '风险'),
                         statusFile=bool(status), gitState=('本次未核实（Git 状态读取失败）' if changes is None else f'{len(changes.splitlines())} 项未提交' if changes else '工作区干净') if owned_git else '未识别独立 Git 仓库',
                         lastCommit=(git(project, 'log', '-1', '--format=%h %ad %s', '--date=short') or '本次未核实') if owned_git else '未知'))
    return rows


def cell(value):
    return str(value).replace('|', '\\|').replace('\n', ' / ')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--projects', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--dashboard', action='store_true', help='Upsert scanner-owned project tasks; preserve manual tasks and tracking files')
    args = parser.parse_args()
    config_file = WORKSPACE / '.subboss/config.json'
    config = json.loads(config_file.read_text()) if config_file.exists() else {}
    root = (args.projects or Path(config.get('projectRoot', WORKSPACE.parent))).expanduser().resolve()
    if not root.is_dir():
        parser.error('Project root does not exist')
    now = datetime.now().astimezone().isoformat(timespec='seconds')
    rows = scan(root)
    output = args.output or WORKSPACE / 'dashboard.md'
    lines = ['# 项目事实盘点', '', f'生成时间：{now}', f'范围：`{root}` 的一级目录；排除管理目录与符号链接。', '',
             '本文件是盘点结果，状态文件中的文字尚未逐项验收；Git 干净或最近提交不等于项目完成。', '',
             '| 项目 | 阶段 | Git 状态 | 最近提交 | 下一步 |', '| --- | --- | --- | --- | --- |']
    for item in rows:
        lines.append('| ' + ' | '.join(cell(item[key]) for key in ('name', 'phase', 'gitState', 'lastCommit', 'next')) + ' |')
    for item in rows:
        lines.extend(['', f'## {item["name"]}', '', f'目录：`{item["path"]}`', '', '### 最近进展', item['progress'], '',
                      '### 当前阻塞', item['blockers'], '', '### 风险', item['risks']])
    output.write_text('\n'.join(lines) + '\n')
    if args.dashboard:
        target = WORKSPACE / 'dashboard-web/state/dashboard.json'
        previous = json.loads(target.read_text()) if target.exists() else {}
        # Keep every historical/manual task. Only scanner-owned tasks still present are refreshed.
        tasks = {task['id']: task for task in previous.get('tasks', [])}
        for item in rows:
            old = tasks.get(item['id'], {})
            if old and old.get('source') != 'project-scan':
                continue
            tasks[item['id']] = dict(id=item['id'], source='project-scan', project=item['name'],
                title=f'{item["name"]}：核实当前进展', status=old.get('status', 'unknown'), category='product',
                stage=f'阶段：{item["phase"]}；{item["gitState"]}', progress=item['progress'],
                remaining=item['blockers'] + '\n' + item['risks'], next=item['next'], owner='待安排',
                suggestedDate='', decisionNeeded=False, sourcePaths=[item['path']], scannedAt=now,
                evidence={key: False
                          for key in ('code', 'build', 'installed', 'committed', 'deployed', 'accepted')})
        snapshot = {**previous, 'updatedAt': now, 'generatedAt': now,
                    'summary300': '已更新项目目录和状态文件盘点；尚需逐项核实风险、优先级与交付证据。',
                    'overallStatus': '待核实', 'priorities': previous.get('priorities', []),
                    'tasks': list(tasks.values())}
        atomic_json(target, snapshot)
    print(f'Scanned {len(rows)} projects → {output}')


if __name__ == '__main__':
    main()
