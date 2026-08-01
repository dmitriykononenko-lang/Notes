#!/usr/bin/env bash
# Сборка архива виджета для загрузки в amoCRM.
# Сначала пред-полётная проверка (validate.py), затем чистый zip
# (manifest.json в корне, без __MACOSX/.DS_Store).
#
# Запуск: bash scripts/package.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Пред-полётная проверка"
python3 scripts/validate.py

echo "==> Сборка task-templates.zip"
rm -f task-templates.zip
cd widget
zip -r ../task-templates.zip . -x '*.DS_Store' -x '__MACOSX/*' > /dev/null
cd "$ROOT"

echo "==> Проверка содержимого архива"
python3 - <<'PY'
import zipfile, json, re, sys
z = zipfile.ZipFile("task-templates.zip")
names = z.namelist()
# manifest в корне
assert "manifest.json" in names, "manifest.json не в корне архива"
# нет мусора
junk = [n for n in names if ".DS_Store" in n or n.startswith("__MACOSX")]
assert not junk, "в архиве мусор: %s" % junk
m = json.loads(z.read("manifest.json"))
src = z.read("script.js").decode("utf-8")
assert src.count("console.") == 0, "console.* в script.js"
print("    version:", m["widget"]["version"])
print("    locale :", m["widget"]["locale"])
print("    files  :", len(names))
PY

echo "==> Готово: task-templates.zip"
