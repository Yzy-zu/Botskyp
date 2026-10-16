#!/usr/bin/python3
"""Gateway contract tests; only temporary files and a fake Docker transport."""
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('gateway', Path(__file__).with_name('mc-control.py'))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


def command(action, args=None, operation=None):
    token = base64.urlsafe_b64encode(json.dumps({'action': action, 'args': args or {}}).encode()).decode().rstrip('=')
    return 'v1 ' + (operation or str(uuid.uuid4())) + ' ' + token


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        (self.state / 'receipts').mkdir(parents=True)
        (self.state / 'backups').mkdir()
        self.data = self.root / 'data'
        (self.data / 'worlds' / 'test world').mkdir(parents=True)
        (self.data / 'worlds' / 'test world' / 'level.dat').write_bytes(b'world data')
        (self.data / 'server.properties').write_text('pvp=true\nallow-cheats=false\ndifficulty=normal\n')
        self.patches = [patch.object(gateway, 'STATE', self.state), patch.object(gateway, 'DATA', self.data)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def invoke(self, text):
        out = io.StringIO()
        with patch.object(sys, 'argv', ['mc-control.py', text]), contextlib.redirect_stdout(out):
            code = gateway.main()
        return code, json.loads(out.getvalue()) if out.getvalue() else None

    def test_rejects_system_commands_and_injections(self):
        attempts = ['id', 'status; id', '$(id)', 'v1 --help', command('console', {'command': 'list;id'}), command('console', {'command': 'list\nstop'}), command('start', {'host': 'evil'}), command('logs', {'lines': True}), command('config-set', {'key': '../file', 'value': 'true'}), command('config-set', {'key': 'max-players', 'value': '-1'}), command('console', {'command': 'stop'})]
        for text in attempts:
            with self.subTest(text=text), self.assertRaises((gateway.Rejected, ValueError)):
                gateway.decode(text)

    def test_rejects_duplicate_json_keys(self):
        token = base64.urlsafe_b64encode(b'{"action":"status","action":"start","args":{}}').decode().rstrip('=')
        with self.assertRaises(gateway.Rejected):
            gateway.decode('v1 ' + str(uuid.uuid4()) + ' ' + token)

    def test_start_already_running_and_stop_already_stopped(self):
        for action, running in [('start', True), ('stop', False)]:
            state = {'Running': running, 'StartedAt': '2026-10-16T10:00:00Z'}
            result = {'online': running, 'running': running}
            with patch.object(gateway, 'inspect', return_value=state), patch.object(gateway, 'status', return_value=result), patch.object(gateway, 'run') as run:
                self.assertEqual(gateway.execute(str(uuid.uuid4()), {'action': action, 'args': {}}), ('ok', result))
                run.assert_not_called()

    def test_restart_verifies_start_timestamp(self):
        before = {'Running': True, 'StartedAt': 'old'}
        for timestamp, expected in [('old', 'uncertain'), ('new', 'ok')]:
            with patch.object(gateway, 'inspect', return_value=before), patch.object(gateway, 'status', return_value={'online': True, 'startedAt': timestamp}), patch.object(gateway, 'run') as run:
                code, _ = gateway.execute(str(uuid.uuid4()), {'action': 'restart', 'args': {}})
                self.assertEqual(code, expected)
                run.assert_called_once_with('restart', '--timeout', '30', gateway.CONTAINER, timeout=45)

    def test_network_not_online_is_not_announced_started(self):
        with patch.object(gateway, 'inspect', return_value={'Running': False}), patch.object(gateway, 'status', return_value={'online': False}), patch.object(gateway, 'run'), patch.object(gateway.time, 'sleep'):
            self.assertEqual(gateway.execute(str(uuid.uuid4()), {'action': 'start', 'args': {}}), ('uncertain', None))

    def test_writes_have_durable_receipt_before_effect_and_no_replay(self):
        operation = str(uuid.uuid4())
        request = command('start', operation=operation)
        def execute(*_):
            receipt = json.loads((self.state / 'receipts' / (operation + '.json')).read_text())
            self.assertEqual(receipt['response']['code'], 'uncertain')
            return 'ok', {'online': True}
        with patch.object(gateway, 'execute', side_effect=execute) as call:
            self.assertEqual(self.invoke(request)[1]['code'], 'ok')
            self.assertEqual(self.invoke(request)[1]['code'], 'ok')
            self.assertEqual(self.invoke(command('stop', operation=operation))[1]['code'], 'conflict')
            call.assert_called_once()

    def test_failed_ssh_side_effect_is_never_repeated(self):
        request = command('backup')
        with patch.object(gateway, 'execute', side_effect=subprocess.TimeoutExpired('docker', 10)) as call:
            self.assertEqual(self.invoke(request)[1]['code'], 'uncertain')
            self.assertEqual(self.invoke(request)[1]['code'], 'uncertain')
            call.assert_called_once()

    def test_crash_receipt_remains_uncertain(self):
        request = command('restart')
        with patch.object(gateway, 'execute', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.invoke(request)
        with patch.object(gateway, 'execute') as call:
            self.assertEqual(self.invoke(request)[1]['code'], 'uncertain')
            call.assert_not_called()

    def test_concurrent_backup_is_busy(self):
        import fcntl
        with (self.state / 'write.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(gateway, 'execute') as call:
                self.assertEqual(self.invoke(command('backup'))[1]['code'], 'busy')
                call.assert_not_called()

    def test_online_backup_does_not_stop_or_copy_live_world(self):
        with patch.object(gateway, 'inspect', return_value={'Running': True}), patch.object(gateway, 'run') as run:
            self.assertEqual(gateway.backup(str(uuid.uuid4())), ('unavailable', None))
            self.assertEqual(list((self.state / 'backups').iterdir()), [])
            run.assert_not_called()

    def test_offline_backup_checks_contents_and_sha256(self):
        with patch.object(gateway, 'inspect', return_value={'Running': False}):
            code, data = gateway.backup(str(uuid.uuid4()))
        self.assertEqual(code, 'ok')
        file = self.state / 'backups' / data['file']
        self.assertEqual(data['sha256'], hashlib.sha256(file.read_bytes()).hexdigest())
        self.assertEqual(data['bytes'], file.stat().st_size)
        with tarfile.open(file) as archive:
            self.assertEqual(archive.extractfile('worlds/test world/level.dat').read(), b'world data')
            self.assertEqual(archive.extractfile('server.properties').read(), (self.data / 'server.properties').read_bytes())

    def test_backup_rejects_symlinks(self):
        (self.data / 'worlds' / 'escape').symlink_to('/etc')
        with patch.object(gateway, 'inspect', return_value={'Running': False}), self.assertRaises(gateway.Rejected):
            gateway.backup(str(uuid.uuid4()))

    def test_property_override_is_unavailable(self):
        with patch.object(gateway, 'run', return_value='["DIFFICULTY=normal"]'):
            self.assertEqual(gateway.execute(str(uuid.uuid4()), {'action': 'config-set', 'args': {'key': 'difficulty', 'value': 'hard'}}), ('unavailable', None))

    def test_property_write_is_verified_and_original_preserved(self):
        operation = str(uuid.uuid4())
        with patch.object(gateway, 'run', return_value='[]'):
            code, data = gateway.execute(operation, {'action': 'config-set', 'args': {'key': 'pvp', 'value': 'false'}})
        self.assertEqual(code, 'ok')
        self.assertTrue(data['restartRequired'])
        self.assertIn('pvp=false', (self.data / 'server.properties').read_text())
        self.assertIn('pvp=true', (self.state / (operation + '.properties.before')).read_text())


if __name__ == '__main__':
    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(GatewayTests))
    if not result.wasSuccessful():
        sys.exit(1)
    print('gateway tests passed: ' + str(result.testsRun))
