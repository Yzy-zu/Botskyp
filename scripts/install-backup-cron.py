#!/usr/bin/env python3
"""Install one local daily backup without replacing unrelated owner cron jobs."""
import os, pathlib, shlex, subprocess
os.umask(0o077)
root=pathlib.Path(__file__).resolve().parent.parent
result=subprocess.run(['crontab','-l'],capture_output=True,text=True)
if result.returncode not in [0,1]:
    raise SystemExit('Cannot inspect current crontab')
current=result.stdout
marker='# botsky-daily-backup'
if marker not in current:
    backup=root/'.local'/'crontab-before.txt'
    if not backup.exists():
        backup.write_text(current)
    command='17 9 * * * cd '+shlex.quote(str(root))+' && scripts/backup.sh >> .local/daily-backup.log 2>&1 '+marker
    subprocess.run(['crontab','-'],input=current.rstrip()+'\n'+command+'\n',text=True,check=True)
print('Daily local backup scheduled (09:17 host time); unrelated cron jobs preserved')
