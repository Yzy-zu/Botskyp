import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

sys.path.insert(0, 'scripts')
import backup as backup_module
from backup import rotate, verify_checksum
spec = importlib.util.spec_from_file_location('scanner', 'scripts/security-scan.py')
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


class BackupSecurity(unittest.TestCase):
    def archive(self, root, number, data=b'valid'):
        path = root / f'botsky-{number:04}.dump'
        path.write_bytes(data)
        path.with_name(path.name + '.sha256').write_text(hashlib.sha256(data).hexdigest() + '  ' + path.name + '\n')
        return path

    def test_retains_seven_verified_archives(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for n in range(12):
                self.archive(root, n)
            self.assertEqual(rotate(root, lambda p: p.read_bytes() == b'valid'), 7)
            self.assertEqual(sorted(p.name for p in root.glob('*.dump')), [f'botsky-{n:04}.dump' for n in range(5, 12)])

    def test_corrupt_archives_do_not_displace_good_copies(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for n in range(7):
                self.archive(root, n)
            bad = self.archive(root, 8)
            bad.write_bytes(b'corrupt')
            self.archive(root, 9, b'invalid archive with valid checksum')
            self.assertFalse(verify_checksum(bad))
            self.assertEqual(rotate(root, lambda p: p.read_bytes() == b'valid'), 7)
            self.assertEqual(len(list(root.glob('*.dump'))), 9)

    def test_checksum_cannot_choose_another_file_or_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            good = self.archive(root, 1)
            link = root / 'botsky-2.dump'
            link.symlink_to(good)
            self.assertFalse(verify_checksum(link))
            good.with_name(good.name + '.sha256').write_text(hashlib.sha256(b'valid').hexdigest() + '  /etc/passwd\n')
            self.assertFalse(verify_checksum(good))

    def test_failed_new_archive_never_rotates_existing_verified_copies(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = root / 'backups'
            directory.mkdir()
            for n in range(7):
                self.archive(directory, n)
            def dump(*args, **kwargs):
                kwargs['stdout'].write(b'corrupt-new-archive')
            with patch.object(backup_module, 'ROOT', root), patch.object(backup_module.subprocess, 'run', dump), patch.object(backup_module, 'archive_valid', return_value=False):
                with self.assertRaises(ValueError):
                    backup_module.backup()
            self.assertEqual(len(list(directory.glob('*.dump'))), 7)
            self.assertEqual(len(list(directory.glob('*.partial'))), 0)

    def test_optional_rclone_is_not_required_for_local_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(backup_module, 'ROOT', Path(tmp)), patch.object(backup_module.subprocess, 'run') as run:
                backup_module.optional_copy(Path(tmp) / 'unused.dump')
                run.assert_not_called()

    def test_scanner_detects_without_printing_values(self):
        samples = ['AIza' + 'a' * 35, 'ghp_' + 'b' * 36, '-----BEGIN ' + 'PRIVATE KEY-----', '12345678' + '90@s.whatsapp.net', 'password="' + 'abC123' * 6 + '"', 'eyJ' + 'a' * 20 + '.' + 'b' * 20 + '.' + 'c' * 20]
        for sample in samples:
            self.assertTrue(scanner.findings(sample))
        self.assertTrue(scanner.findings('opaque credential: local-value', ('local-value',)))
        self.assertFalse(scanner.findings('OWNER_JIDS=${OWNER_JIDS} 100@s.whatsapp.net password="${PASSWORD}"'))

    def test_history_uses_local_private_values_without_printing_them(self):
        value = 'historical-opaque-test-value'
        content = ('configuration: ' + value).encode()
        self.assertFalse(scanner.findings(content.decode()))
        header = f'abc blob {len(content)}'.encode()
        responses = [subprocess.CompletedProcess([], 0, header + b'\n'),
                     subprocess.CompletedProcess([], 0, header + b'\n' + content + b'\n')]
        output = io.StringIO()
        with patch.object(scanner.subprocess, 'check_output', return_value=b'abc old-file\n'), \
                patch.object(scanner.subprocess, 'run', side_effect=responses), redirect_stdout(output):
            self.assertEqual(scanner.history_findings([value]), 1)
        self.assertIn('local-private-value', output.getvalue())
        self.assertNotIn(value, output.getvalue())

    def test_restore_waits_for_real_tcp_query_before_restoring(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'scripts').mkdir()
            (root / 'bin').mkdir()
            (root / 'backups').mkdir()
            for name in ('restore-test.sh', 'common.sh', 'backup.py', 'local_config.py'):
                shutil.copy(Path('scripts') / name, root / 'scripts' / name)
            (root / '.env').touch(mode=0o600)
            archive = self.archive(root / 'backups', 1)
            docker = root / 'bin' / 'docker'
            docker.write_text('''#!/usr/bin/env python3
import json, sys
from pathlib import Path
args = sys.argv[1:]
with open('calls.jsonl', 'a') as log:
    log.write(json.dumps(args) + '\\n')
if args[0] in ('compose', 'inspect', 'run'):
    print('isolated-test-image')
elif args[0] == 'exec':
    client = next((name for name in ('psql', 'pg_restore', 'pg_isready') if name in args), None)
    if client is None or '-h' not in args or args[args.index('-h') + 1] != '127.0.0.1':
        sys.exit(91)
    if args[args.index('-d') + 1] != 'botsky_restore_test':
        sys.exit(92)
    if client == 'pg_isready':
        sys.exit(0)  # Misleading availability must never authorize the restore.
    if client == 'psql' and 'SELECT 1' in args:
        count = Path('attempts')
        previous = int(count.read_text()) if count.exists() else 0
        count.write_text(str(previous + 1))
        sys.exit(1 if previous == 0 else 0)
    if not Path('attempts').exists() or int(Path('attempts').read_text()) < 2:
        sys.exit(93)
    if client == 'pg_restore':
        sys.stdin.buffer.read()
''')
            docker.chmod(0o700)
            sleep = root / 'bin' / 'sleep'
            sleep.write_text('#!/bin/sh\nexit 0\n')
            sleep.chmod(0o700)
            result = subprocess.run(['bash', 'scripts/restore-test.sh', str(archive.relative_to(root))],
                                    cwd=root, env={**os.environ, 'PATH': str(root / 'bin') + os.pathsep + os.environ['PATH']},
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = [json.loads(line) for line in (root / 'calls.jsonl').read_text().splitlines()]
            queries = [args for args in calls if 'SELECT 1' in args]
            self.assertEqual(len(queries), 2)
            clients = [args for args in calls if args[0] == 'exec']
            self.assertEqual(len(clients), 4)
            for args in clients:
                self.assertEqual(args[args.index('-h') + 1], '127.0.0.1')
            self.assertIn('pg_restore', clients[2])
            self.assertIn('psql', clients[3])
            self.assertEqual(calls[-1][0:2], ['rm', '-f'])


unittest.main()
