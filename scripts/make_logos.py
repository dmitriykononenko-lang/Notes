#!/usr/bin/env python3
"""Генерация набора логотипов для amoCRM-виджета «Шаблоны задач».

Фирменный стиль KO:AGENCY: красный фон, белая графика, гротеск
с разрядкой для вордмарки. Создаёт в widget/images/ стандартный
набор размеров amoМаркета.
"""
from PIL import Image, ImageDraw, ImageFont

RED = (230, 14, 14, 255)
WHITE = (255, 255, 255, 255)
FONT_PATH = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"

SIZES = {
    # logo.png — полноширинный баннер в шапке блока правой панели (как Zoom):
    # широкое соотношение → ветка `wide` (иконка + вордмарка, full-bleed)
    "logo.png": (348, 72),
    "logo_min.png": (84, 84),
    "logo_small.png": (108, 108),
    "logo_medium.png": (240, 84),
    "logo_dp.png": (174, 109),
    "logo_main.png": (400, 272),
}


def draw_icon(draw, cx, cy, size):
    """Чек-лист: три строки, у первой галочка вместо маркера."""
    line_w = max(2, size // 14)
    row_gap = size // 3
    top = cy - row_gap
    bullet = size // 7
    text_left = cx - size // 2 + bullet * 2 + size // 10
    text_right = cx + size // 2

    for row in range(3):
        y = top + row * row_gap
        bx = cx - size // 2
        if row == 0:
            draw.line(
                [(bx, y), (bx + bullet, y + bullet), (bx + bullet * 2, y - bullet)],
                fill=WHITE, width=line_w, joint="curve",
            )
        else:
            draw.rectangle(
                [bx, y - bullet, bx + bullet * 2 - line_w, y + bullet],
                outline=WHITE, width=line_w,
            )
        draw.line([(text_left, y), (text_right, y)], fill=WHITE, width=line_w)


def draw_tracked_text(draw, text, font, center_x, center_y, tracking):
    """Текст с разрядкой (letter-spacing), как в фирменном написании."""
    widths = [draw.textlength(ch, font=font) for ch in text]
    total = sum(widths) + tracking * (len(text) - 1)
    ascent, descent = font.getmetrics()
    x = center_x - total / 2
    y = center_y - (ascent + descent) / 2
    for ch, w in zip(text, widths):
        draw.text((x, y), ch, font=font, fill=WHITE)
        x += w + tracking


def make_logo(path, width, height):
    scale = 4  # рисуем в 4x и уменьшаем для сглаживания
    w, h = width * scale, height * scale
    img = Image.new("RGBA", (w, h), RED)
    draw = ImageDraw.Draw(img)

    wide = width / height > 2          # logo_medium 240x84
    large = width >= 300               # logo_main 400x272

    if wide:
        # иконка слева, вордмарка справа
        icon_size = int(h * 0.45)
        icon_cx = int(h * 0.55)
        draw_icon(draw, icon_cx, h // 2, icon_size)
        text_left = icon_cx + icon_size // 2 + int(h * 0.18)
        text_right = w - int(h * 0.18)
        tracking = int(h * 0.02)
        # автоподбор кегля под доступную ширину
        font_size = int(h * 0.30)
        while font_size > 8:
            font = ImageFont.truetype(FONT_PATH, font_size)
            total = sum(draw.textlength(ch, font=font) for ch in "KO:AGENCY") + tracking * 8
            if total <= text_right - text_left:
                break
            font_size -= 2
        draw_tracked_text(draw, "KO:AGENCY", font, (text_left + text_right) / 2, h // 2, tracking)
    elif large:
        # иконка по центру, вордмарка под ней
        icon_size = int(h * 0.42)
        draw_icon(draw, w // 2, int(h * 0.40), icon_size)
        font = ImageFont.truetype(FONT_PATH, int(h * 0.115))
        draw_tracked_text(draw, "KO:AGENCY", font, w // 2, int(h * 0.78), int(h * 0.012))
    else:
        # компактные форматы: только иконка
        icon_size = int(min(w, h) * 0.52)
        draw_icon(draw, w // 2, h // 2, icon_size)

    img = img.resize((width, height), Image.LANCZOS)
    img.save(path)
    print(f"{path}: {width}x{height}")


if __name__ == "__main__":
    import os
    out_dir = os.path.join(os.path.dirname(__file__), "..", "widget", "images")
    os.makedirs(out_dir, exist_ok=True)
    for name, (width, height) in SIZES.items():
        make_logo(os.path.join(out_dir, name), width, height)
