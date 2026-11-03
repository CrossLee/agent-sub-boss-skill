import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.request import urlopen

REPO = Path(__file__).resolve().parents[1]
BOOTSTRAP = REPO / 'skills/sub-boss/scripts/bootstrap.py'


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='subboss-integration-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.projects = self.base / 'project root 空格'
        self.projects.mkdir()
        self.workspace = self.projects / 'custom-control'
        self.site = self.projects / 'demo-site'
        self.site.mkdir()
        (self.site / 'index.html').write_text('<h1>Fixture</h1>')
        (self.site / 'PROJECT_STATUS.md').write_text('# 演示项目\n\n## 当前阶段\n验证 | 待验收\n\n## 最近进展\n页面已写入\n\n## 下一步\n- 确认预览\n')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        result = self.run_command(sys.executable, BOOTSTRAP, '--projects', self.projects, '--dest', self.workspace, '--port', str(self.port))
        self.assertEqual(result.returncode, 0, result.stderr)

    def run_command(self, *args):
        return subprocess.run([str(a) for a in args], capture_output=True, text=True, timeout=35)

    def test_scan_preserves_user_state_and_rejects_reinitialization(self):
        state = self.workspace / 'dashboard-web/state'
        actions = {'version': 1, 'items': {'manual': {'action': 'completed', 'updatedAt': '2026-01-01'}}}
        (state / 'actions.json').write_text(json.dumps(actions))
        (state / 'category-assignments.json').write_text('{"version":1,"items":{"manual":"research"}}')
        protected = {name: hashlib.sha256((state / name).read_bytes()).hexdigest() for name in ['actions.json', 'category-assignments.json']}
        snapshot = json.loads((state / 'dashboard.json').read_text())
        snapshot['tasks'] = [{'id': 'manual', 'source': 'reviewed', 'title': 'Manual task', 'status': 'completed'}]
        (state / 'dashboard.json').write_text(json.dumps(snapshot))
        outside = self.base / 'outside'
        outside.mkdir()
        (self.projects / 'symlink-not-scanned').symlink_to(outside, target_is_directory=True)
        for _ in range(2):
            result = self.run_command(sys.executable, self.workspace / 'scripts/scan_projects.py', '--dashboard')
            self.assertEqual(result.returncode, 0, result.stderr)
        dashboard = json.loads((state / 'dashboard.json').read_text())
        self.assertEqual(len(dashboard['tasks']), 2)
        self.assertEqual(dashboard['tasks'][0], snapshot['tasks'][0])
        project = dashboard['tasks'][1]
        self.assertEqual(project['status'], 'unknown')
        self.assertEqual(project['next'], '- 确认预览')
        self.assertTrue(all(value is False for value in project['evidence'].values()))
        self.assertIn('验证 \\| 待验收', (self.workspace / 'dashboard.md').read_text())
        for name, digest in protected.items():
            self.assertEqual(hashlib.sha256((state / name).read_bytes()).hexdigest(), digest)
        refused = self.run_command(sys.executable, BOOTSTRAP, '--projects', self.projects, '--dest', self.workspace)
        self.assertNotEqual(refused.returncode, 0)
        self.assertEqual(json.loads((state / 'actions.json').read_text()), actions)

    def test_launcher_health_catalog_and_stop(self):
        launcher = self.workspace / 'scripts/dashboard_service.mjs'
        self.addCleanup(lambda: self.run_command('node', launcher, 'stop'))
        started = self.run_command('node', launcher, 'start')
        self.assertEqual(started.returncode, 0, started.stderr)
        self.assertIn(f':{self.port}', started.stdout)
        record = json.loads((self.workspace / '.subboss/dashboard-process.json').read_text())
        with urlopen(f'http://127.0.0.1:{self.port}/api/health') as response:
            self.assertEqual(json.load(response)['instanceToken'], record['token'])
        again = self.run_command('node', launcher, 'start')
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(json.loads((self.workspace / '.subboss/dashboard-process.json').read_text()), record)
        catalog = self.run_command('node', self.workspace / 'scripts/runtime_catalog.mjs', 'scan')
        self.assertEqual(catalog.returncode, 0, catalog.stderr)
        with urlopen(f'http://127.0.0.1:{self.port}/api/runtime') as response:
            payload = json.load(response)
            self.assertEqual(len(payload['projects']), 1)
            self.assertEqual(payload['projects'][0]['name'], 'demo-site')
        stopped = self.run_command('node', launcher, 'stop')
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        with socket.socket() as sock:
            sock.settimeout(1)
            self.assertNotEqual(sock.connect_ex(('127.0.0.1', self.port)), 0)

    def test_installer_is_non_overwriting(self):
        target = self.base / 'skills'
        args = [sys.executable, REPO / 'scripts/install_skill.py', '--skills-dir', target]
        self.assertEqual(self.run_command(*args).returncode, 0)
        installed = target / 'sub-boss/SKILL.md'
        self.assertTrue(installed.is_file())
        installed.write_text('User changes')
        self.assertNotEqual(self.run_command(*args).returncode, 0)
        self.assertEqual(installed.read_text(), 'User changes')

    def test_git_failure_is_not_reported_clean(self):
        spec = importlib.util.spec_from_file_location('fixture_scanner', self.workspace / 'scripts/scan_projects.py')
        scanner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(scanner)
        with patch.object(scanner, 'git', side_effect=[str(self.site), None, None]):
            rows = scanner.scan(self.projects)
        self.assertIn('未核实', rows[0]['gitState'])
        self.assertNotIn('干净', rows[0]['gitState'])
        self.assertEqual(rows[0]['lastCommit'], '本次未核实')


if __name__ == '__main__':
    unittest.main()
