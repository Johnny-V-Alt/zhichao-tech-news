"""SQLite's native backup API; safe while the local reader is running."""
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
import sys

app = Path(__file__).resolve().parents[1]
with sqlite3.connect(app / 'data/content.sqlite3', timeout=15) as connection:
    status = connection.execute('PRAGMA integrity_check').fetchone()[0]
    if status != 'ok':
        raise RuntimeError(status)
    if sys.argv[1:] == ['backup']:
        path = app / 'data/backups' / ('content-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.sqlite3')
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as target:
            connection.backup(target)
        print(json.dumps({'integrity': status, 'backup': str(path)}, ensure_ascii=False))
    elif sys.argv[1:] == ['check']:
        print(json.dumps({'integrity': status, 'articles': connection.execute('SELECT COUNT(*) FROM content_articles').fetchone()[0]}))
    else:
        raise ValueError('Use check or backup')
