#!/usr/bin/env python3
"""Пред-полётная проверка виджета перед упаковкой/загрузкой в amoCRM.

Ловит локально то, на чём отклоняют в кабинете (по урокам «Дублей»):
manifest в корне и валиден, обязательные поля, размеры логотипов,
паритет i18n (ru/en), отсутствие отладочного вывода (console.*),
чистота набора файлов. Падает с ненулевым кодом при любой ошибке.

Запуск: python3 scripts/validate.py
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WIDGET = os.path.join(ROOT, "widget")

errors = []
warnings = []


def err(msg):
    errors.append(msg)


def warn(msg):
    warnings.append(msg)


# --- manifest ---------------------------------------------------------------
manifest_path = os.path.join(WIDGET, "manifest.json")
manifest = None
if not os.path.isfile(manifest_path):
    err("manifest.json отсутствует в корне widget/")
else:
    try:
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
    except Exception as e:
        err("manifest.json — невалидный JSON: %s" % e)

if manifest:
    w = manifest.get("widget", {})
    for field in ("name", "description", "short_description", "version",
                  "interface_version", "locale"):
        if not w.get(field) and w.get(field) != 0:
            err("manifest.widget.%s не задан" % field)
    support = w.get("support", {})
    if not support.get("link"):
        err("manifest.widget.support.link не задан")
    if not support.get("email"):
        err("manifest.widget.support.email не задан")
    if not manifest.get("locations"):
        err("manifest.locations пуст")
    ver = str(w.get("version", ""))
    if not re.match(r"^\d+\.\d+\.\d+$", ver):
        warn("version '%s' не в формате semver x.y.z" % ver)
    locale = w.get("locale", [])
    if "ru" not in locale or "en" not in locale:
        warn("locale = %s (ожидались ru и en)" % locale)
    if w.get("interface_version") != 2:
        warn("interface_version = %s (спека: 2)" % w.get("interface_version"))
    # installation по спеке — строка "y"/"n", не булево
    inst = w.get("installation")
    if inst not in ("y", "n"):
        err("installation = %r, по спеке должно быть \"y\" или \"n\"" % inst)
    # маркетплейс-поля (для публичной публикации)
    for mf in ("free", "category"):
        if mf not in manifest:
            warn("нет маркетплейс-поля '%s' (нужно для публичного виджета)" % mf)
    if "countries" not in manifest:
        warn("нет 'countries' (нужно для публичного виджета)")


# --- логотипы ---------------------------------------------------------------
# 5 обязательных логотипов с точными размерами (официальная спека) +
# logo_dp 174x109 (только для Digital Pipeline). Каждый ≤ 300 КБ.
REQUIRED_LOGOS = {
    "logo_min.png": (84, 84),
    "logo_medium.png": (240, 84),
    "logo.png": (130, 100),
    "logo_main.png": (400, 272),
    "logo_small.png": (108, 108),
}
OPTIONAL_LOGOS = {"logo_dp.png": (174, 109)}
MAX_LOGO_BYTES = 300 * 1024

try:
    from PIL import Image
    have_pil = True
except Exception:
    have_pil = False
    warn("Pillow не установлен — размеры логотипов не проверены")

images_dir = os.path.join(WIDGET, "images")


def check_logo(name, size, required):
    path = os.path.join(images_dir, name)
    if not os.path.isfile(path):
        (err if required else warn)("нет логотипа images/%s" % name)
        return
    if os.path.getsize(path) > MAX_LOGO_BYTES:
        err("images/%s больше 300 КБ" % name)
    if have_pil:
        got = Image.open(path).size
        if got != size:
            err("images/%s размер %sx%s, требуется %sx%s"
                % (name, got[0], got[1], size[0], size[1]))


for name, size in REQUIRED_LOGOS.items():
    check_logo(name, size, required=True)
for name, size in OPTIONAL_LOGOS.items():
    check_logo(name, size, required=False)


# --- script.js: отсутствие console.* ----------------------------------------
script_path = os.path.join(WIDGET, "script.js")
script_src = ""
if not os.path.isfile(script_path):
    err("нет widget/script.js")
else:
    with open(script_path, encoding="utf-8") as f:
        script_src = f.read()
    n_console = len(re.findall(r"\bconsole\.", script_src))
    if n_console:
        err("в script.js остался отладочный вывод console.* (%d)" % n_console)
    if "debugger" in script_src:
        err("в script.js остался debugger")


# --- i18n-паритет ru/en -----------------------------------------------------
def load_locale(code):
    path = os.path.join(WIDGET, "i18n", "%s.json" % code)
    if not os.path.isfile(path):
        err("нет i18n/%s.json" % code)
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        err("i18n/%s.json невалиден: %s" % (code, e))
        return None


ru = load_locale("ru")
en = load_locale("en")

if script_src and ru is not None and en is not None:
    keys = set(re.findall(r"\bt\('([^']+)'", script_src))
    # динамические ключи deadlines.{preset}
    keys.discard("deadlines.")
    for preset in ("now", "min15", "min30", "hour1", "today_end",
                   "tomorrow", "days2", "days3", "week"):
        keys.add("deadlines." + preset)

    def has_key(tree, dotted):
        node = tree
        for part in dotted.split("."):
            if isinstance(node, dict) and part in node:
                node = node[part]
            else:
                return False
        return isinstance(node, str)

    for key in sorted(keys):
        # пропускаем явно неполные (конкатенация в коде)
        if key.endswith("."):
            continue
        if not has_key(ru, key):
            err("i18n: ключ '%s' отсутствует в ru.json" % key)
        if not has_key(en, key):
            err("i18n: ключ '%s' отсутствует в en.json" % key)


# --- чистота файлов ---------------------------------------------------------
for dirpath, dirnames, filenames in os.walk(WIDGET):
    for junk in ("__MACOSX",):
        if junk in dirnames:
            err("в widget/ есть мусорная папка %s" % junk)
    for fn in filenames:
        if fn == ".DS_Store":
            err("в widget/ есть .DS_Store")


# --- вывод ------------------------------------------------------------------
for wmsg in warnings:
    print("WARN:  " + wmsg)
if errors:
    for emsg in errors:
        print("ERROR: " + emsg)
    print("\nПроверка НЕ пройдена: %d ошибок." % len(errors))
    sys.exit(1)

print("OK: виджет прошёл пред-полётную проверку (v%s)."
      % (manifest["widget"]["version"] if manifest else "?"))
