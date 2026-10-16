#!/usr/bin/python3 -I
"""Root-owned Bedrock gateway; never imports from the working directory."""
import base64
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import uuid

CONTAINER = 'mc-bedrock'
DATA = Path('/home/petrov/docker/minecraft/data')
STATE = Path('/var/lib/botsky-minecraft')
DOCKER = '/usr/bin/docker'
CONSOLE = {'list', 'time query daytime', 'time set day', 'time set night', 'weather clear', 'weather rain'}
PROPERTIES = {'difficulty': {'peaceful', 'easy', 'normal', 'hard'}, 'gamemode': {'survival', 'creative', 'adventure'}, 'max-players': {'1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '12', '16', '20'}, 'pvp': {'true', 'false'}, 'allow-cheats': {'true', 'false'}}
ACTIONS = {'status', 'players', 'resources', 'worlds', 'addons', 'logs', 'config-get', 'config-set', 'start', 'stop', 'restart', 'backup', 'console'}
WRITES = {'start', 'stop', 'restart', 'backup', 'console', 'config-set'}


class Rejected(Exception):
    pass


def decode(command):
    match = re.fullmatch(r'v1 ([a-f0-9-]{36}) ([A-Za-z0-9_-]{1,2048})', command)
    if not match:
        raise Rejected('command')
    operation, token = match.groups()
    if str(uuid.UUID(operation)) != operation:
        raise Rejected('id')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise Rejected('duplicate')
            result[key] = value
        return result
    request = json.loads(base64.urlsafe_b64decode(token + '=' * (-len(token) % 4)), object_pairs_hook=unique)
    if not isinstance(request, dict) or set(request) != {'action', 'args'}:
        raise Rejected('request')
    action, args = request['action'], request['args']
    if not isinstance(action, str) or action not in ACTIONS or not isinstance(args, dict):
        raise Rejected('action')
    fields = {'logs': {'lines'}, 'config-set': {'key', 'value'}, 'console': {'command'}}.get(action, set())
    if set(args) != fields:
        raise Rejected('args')
    if action == 'logs' and (type(args['lines']) is not int or not 1 <= args['lines'] <= 100):
        raise Rejected('lines')
    if action == 'console' and (not isinstance(args['command'], str) or args['command'] not in CONSOLE):
        raise Rejected('console')
    if action == 'config-set' and (not isinstance(args['key'], str) or args['key'] not in PROPERTIES or not isinstance(args['value'], str) or args['value'] not in PROPERTIES[args['key']]):
        raise Rejected('property')
    return operation, request


def run(*args, timeout=10):
    # Redirect to disk, bound reads, and kill the command on timeout. No shell.
    import tempfile
    with tempfile.TemporaryFile() as output:
        subprocess.run([DOCKER, *args], check=True, timeout=timeout, stdout=output, stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin'})
        output.seek(0)
        value = output.read(65537)
        if len(value) > 65536:
            raise Rejected('output-limit')
        return value.decode('utf-8', errors='replace').strip()


def inspect():
    # Never expose Config.Env: it can contain credentials.
    return json.loads(run('inspect', '--format', '{{json .State}}', CONTAINER))


def status():
    state = inspect()
    running = state['Running'] is True
    online, players, maximum = False, None, None
    if running:
        try:
            pong = run('exec', CONTAINER, 'mc-monitor', 'status-bedrock', '--host', '127.0.0.1')
            count = re.search(r'online=(\d+) max=(\d+)', pong)
            if count:
                online, players, maximum = True, int(count[1]), int(count[2])
        except (subprocess.SubprocessError, Rejected):
            online = False
    started = state['StartedAt']
    uptime = 0
    if running:
        instant = datetime.datetime.fromisoformat(re.sub(r'(\.\d{6})\d+Z$', r'\1+00:00', started).replace('Z', '+00:00'))
        uptime = max(0, int(time.time() - instant.timestamp()))
    return {'online': online, 'running': running, 'startedAt': started, 'uptimeSeconds': uptime, 'players': players, 'maxPlayers': maximum}


def console(command):
    since = datetime.datetime.now(datetime.timezone.utc).isoformat()
    run('exec', CONTAINER, 'send-command', *command.split(' '))
    # send-command only writes stdin. Exit zero is not evidence of game effects.
    time.sleep(0.3)
    return clean(run('logs', '--since', since, '--tail', '30', CONTAINER))


def clean(text):
    text = re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', '', text)
    text = re.sub(r'(?i)(token|password|secret|apikey|api_key)\s*[=:]\s*\S+', r'\1=[redacted]', text)
    return text[-12000:]


def properties():
    file = DATA / 'server.properties'
    if file.is_symlink() or not file.is_file():
        raise Rejected('property-file')
    return file, file.read_text()


def backup(operation):
    # A live LevelDB copy is not safe. Never stop/pause the server implicitly.
    if inspect()['Running']:
        return 'unavailable', None
    import tarfile
    import shutil
    source = DATA / 'worlds'
    if source.is_symlink() or not source.is_dir():
        raise Rejected('worlds')
    files = [p for p in source.rglob('*')]
    if any(p.is_symlink() or (not p.is_dir() and not p.is_file()) for p in files):
        raise Rejected('links')
    needed = sum(p.stat().st_size for p in files if p.is_file())
    if shutil.disk_usage(STATE).free < needed * 2 + 104857600:
        return 'failed', None
    file = STATE / 'backups' / (operation + '.tar')
    partial = file.with_suffix('.partial')
    # Exclusive creation; existing artifacts are never overwritten or removed.
    with partial.open('xb') as stream:
        with tarfile.open(fileobj=stream, mode='w') as archive:
            for path in [source, *files]:
                if inspect()['Running']:
                    raise Rejected('server-started-during-backup')
                archive.add(path, arcname=str(path.relative_to(DATA)), recursive=False)
            prop, _ = properties()
            archive.add(prop, arcname='server.properties', recursive=False)
        stream.flush()
        os.fsync(stream.fileno())
    if inspect()['Running']:
        raise Rejected('server-started-during-backup')
    # Verify every regular file payload, not only the archive header.
    digest = hashlib.sha256()
    with partial.open('rb') as stream:
        while block := stream.read(1048576):
            digest.update(block)
    with tarfile.open(partial, 'r') as archive:
        for member in archive.getmembers():
            if member.isfile():
                stream = archive.extractfile(member)
                size = 0
                while block := stream.read(1048576):
                    size += len(block)
                if size != member.size:
                    raise Rejected('archive')
    partial.rename(file)
    return 'ok', {'file': file.name, 'bytes': file.stat().st_size, 'sha256': digest.hexdigest()}


def execute(operation, request):
    action, args = request['action'], request['args']
    if action == 'status':
        return 'ok', status()
    if action == 'players':
        data = status()
        names = None
        if data['online']:
            output = console('list')
            match = re.search(r'There are (\d+)/\d+ players online:\s*([^\r\n]*)', output)
            if match and int(match[1]) == data['players']:
                names = [p.strip() for p in match[2].split(',') if p.strip()]
                if len(names) != data['players'] or any(len(p) > 80 for p in names):
                    names = None
            if data['players'] == 0:
                names = []
        return 'ok', {**data, 'names': names}
    if action in {'start', 'stop', 'restart'}:
        before = inspect()
        if action == 'start' and not before['Running']:
            run('start', CONTAINER, timeout=30)
        elif action == 'stop' and before['Running']:
            run('stop', '--timeout', '30', CONTAINER, timeout=40)
        elif action == 'restart':
            run('restart', '--timeout', '30', CONTAINER, timeout=45)
        after = status()
        if action == 'stop' and after['running']:
            return 'uncertain', None
        if action in {'start', 'restart'}:
            for _ in range(10):
                if after['online']:
                    break
                time.sleep(2)
                after = status()
            if not after['online'] or (action == 'restart' and after['startedAt'] == before['StartedAt']):
                return 'uncertain', None
        return 'ok', after
    if action == 'console':
        if not status()['online']:
            return 'offline', None
        return 'ok', {'accepted': True, 'output': console(args['command'])}
    if action == 'logs':
        return 'ok', {'text': clean(run('logs', '--tail', str(args['lines']), CONTAINER))}
    if action == 'resources':
        return 'ok', {'text': clean(run('stats', '--no-stream', '--format', '{{.CPUPerc}} CPU; {{.MemUsage}} RAM; {{.NetIO}} net', CONTAINER))}
    if action in {'worlds', 'addons'}:
        roots = [DATA / 'worlds'] if action == 'worlds' else [DATA / 'behavior_packs', DATA / 'resource_packs']
        items = [clean(p.name) for root in roots if root.is_dir() and not root.is_symlink() for p in root.iterdir() if p.is_dir() and not p.is_symlink()]
        return 'ok', {'items': sorted(items)[:100]}
    if action in {'config-get', 'config-set'}:
        file, text = properties()
        values = dict(line.split('=', 1) for line in text.splitlines() if '=' in line and not line.startswith('#'))
        if action == 'config-get':
            return 'ok', {'properties': {k: values.get(k, '') for k in PROPERTIES}}
        # Container env wins at boot. Refuse an edit that would be silently undone.
        env = json.loads(run('inspect', '--format', '{{json .Config.Env}}', CONTAINER))
        env_key = args['key'].upper().replace('-', '_')
        if any(item.startswith(env_key + '=') for item in env):
            return 'unavailable', None
        if args['key'] not in values:
            return 'unavailable', None
        changed = re.sub(r'^' + re.escape(args['key']) + r'=.*$', args['key'] + '=' + args['value'], text, flags=re.M)
        saved = STATE / (operation + '.properties.before')
        saved.write_text(text)
        # Atomic replacement preserves the original owner/mode and survives interruption.
        metadata = file.stat()
        pending = file.with_name('.botsky-' + operation + '.properties')
        with pending.open('x') as stream:
            stream.write(changed)
            stream.flush()
            os.fsync(stream.fileno())
        os.chown(pending, metadata.st_uid, metadata.st_gid)
        os.chmod(pending, metadata.st_mode & 0o777)
        pending.replace(file)
        if file.read_text() != changed:
            return 'uncertain', None
        return 'ok', {'key': args['key'], 'value': args['value'], 'restartRequired': True}
    if action == 'backup':
        return backup(operation)
    raise Rejected('action')


def persist(path, result):
    temp = path.with_suffix('.tmp')
    with temp.open('w') as stream:
        json.dump(result, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temp.replace(path)
    descriptor = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def main():
    try:
        operation, request = decode(sys.argv[1] if len(sys.argv) == 2 else '')
    except (Rejected, ValueError, TypeError, KeyError):
        print('Rejected', file=sys.stderr)
        return 64
    action = request['action']
    result = {'v': 1, 'id': operation, 'action': action, 'ok': False, 'code': 'uncertain', 'data': None}
    lock = (STATE / 'write.lock').open('a')
    with lock:
        # Reads involving console share this lock: logs cannot be attributed to two calls.
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            result['code'] = 'busy'
            print(json.dumps(result))
            return 0
        receipt = STATE / 'receipts' / (operation + '.json')
        fingerprint = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
        if action in WRITES:
            if receipt.exists():
                previous = json.loads(receipt.read_text())
                if previous['hash'] == fingerprint:
                    print(json.dumps(previous['response']))
                    return 0
                result['code'] = 'conflict'
                print(json.dumps(result))
                return 0
            persist(receipt, {'hash': fingerprint, 'response': result})
        def expired(_signum, _frame):
            raise Rejected('timeout')
        signal.signal(signal.SIGALRM, expired)
        signal.alarm(160)
        try:
            code, data = execute(operation, request)
            result.update(code=code, ok=code == 'ok', data=data)
        except (subprocess.SubprocessError, OSError, ValueError, KeyError, Rejected):
            # A failed command may have produced effects before losing its response.
            result.update(code='uncertain' if action in WRITES else 'failed', data=None)
        finally:
            signal.alarm(0)
        if action in WRITES:
            persist(receipt, {'hash': fingerprint, 'response': result})
        print(json.dumps(result))
        return 0


if __name__ == '__main__':
    sys.exit(main())
