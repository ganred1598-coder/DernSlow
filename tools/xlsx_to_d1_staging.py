import datetime as dt
import json
import re
import sqlite3
import sys
from pathlib import Path

import openpyxl

SOURCE = Path(sys.argv[1])
OUTPUT = Path(sys.argv[2])
SKIP = {"AdminSessions"}

def ident(value):
    text = re.sub(r"[^a-z0-9]+", "_", str(value).strip().lower()).strip("_")
    return text or "column"

def sql_value(value):
    if value is None:
        return "NULL"
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        value = value.isoformat()
    elif isinstance(value, bool):
        value = "1" if value else "0"
    elif not isinstance(value, str):
        value = str(value)
    return "'" + value.replace("'", "''") + "'"

workbook = openpyxl.load_workbook(SOURCE, read_only=True, data_only=True)
lines = [
    "-- Generated locally from the read-only DERNSLOW OS Google Sheet export.",
    "-- AdminSessions is deliberately excluded: legacy session tokens must not be migrated.",
    "PRAGMA foreign_keys = OFF;",
    "CREATE TABLE IF NOT EXISTS migration_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
]
summary = []

for sheet in workbook.worksheets:
    rows = list(sheet.iter_rows(values_only=True))
    if not rows or sheet.title in SKIP:
        summary.append({"sheet": sheet.title, "rows": 0, "status": "excluded" if sheet.title in SKIP else "empty"})
        continue
    headers = [ident(value) for value in rows[0]]
    seen = {}
    for index, header in enumerate(headers):
        seen[header] = seen.get(header, 0) + 1
        if seen[header] > 1:
            headers[index] = f"{header}_{seen[header]}"
    data = [row for row in rows[1:] if any(value not in (None, "") for value in row)]
    table = "staging_" + ident(sheet.title)
    lines.append(f'DROP TABLE IF EXISTS "{table}";')
    lines.append(f'CREATE TABLE "{table}" ({", ".join(f"\"{h}\" TEXT" for h in headers)});')
    for row in data:
        values = list(row[:len(headers)]) + [None] * max(0, len(headers) - len(row))
        lines.append(f'INSERT INTO "{table}" ({", ".join(f"\"{h}\"" for h in headers)}) VALUES ({", ".join(sql_value(v) for v in values)});')
    summary.append({"sheet": sheet.title, "table": table, "rows": len(data), "status": "included"})

metadata = json.dumps(summary, ensure_ascii=False, separators=(",", ":"))
lines.append("INSERT OR REPLACE INTO migration_metadata(key,value) VALUES ('source','DERNSLOW OS Google Sheets export');")
lines.append("INSERT OR REPLACE INTO migration_metadata(key,value) VALUES ('generated_at',datetime('now'));")
lines.append("INSERT OR REPLACE INTO migration_metadata(key,value) VALUES ('summary'," + sql_value(metadata) + ");")
lines.extend(["PRAGMA foreign_keys = ON;"])
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
validation = sqlite3.connect(":memory:")
validation.executescript(OUTPUT.read_text(encoding="utf-8"))
validated_tables = validation.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name LIKE 'staging_%'").fetchone()[0]
print(json.dumps(summary, ensure_ascii=False, indent=2))
print(f"Validated SQLite/D1 staging tables: {validated_tables}")
