#!/usr/bin/env python3
"""Генерация набора логотипов для amoCRM-виджета «Шаблоны задач».

Создаёт в widget/images/ стандартный набор размеров amoМаркета:
logo.png 130x100, logo_min.png 84x84, logo_small.png 108x108,
logo_medium.png 240x84, logo_dp.png 174x109, logo_main.png 400x272.

Дизайн: синяя плашка со скруглением, белый чек-лист (строки задач,
первая отмечена галочкой).
"""
from PIL import Image, ImageDraw

BLUE = (76, 139, 247, 255)
WHITE = (255, 255, 255, 255)

SIZES = {
    "logo.png": (130, 100),
    "logo_min.png": (84, 84),
    "logo_small.png": (108, 108),
    "logo_medium.png": (240, 84),
    "logo_dp.png": (174, 109),
    "logo_main.png": (400, 272),
}


def draw_icon(draw, cx, cy, size):
    """Чек-лист: три строки, у первой галочка вместо маркера."""
    line_w = max(2, size // 16)
    rows = 3
    row_gap = size // 3
    top = cy - row_gap
    bullet = size // 7
    text_left = cx - size // 2 + bullet * 2 + size // 10
    text_right = cx + size // 2

    for row in range(rows):
        y = top + row * row_gap
        bx = cx - size // 2
        if row == 0:
            # галочка
            draw.line(
                [(bx, y), (bx + bullet, y + bullet), (bx + bullet * 2, y - bullet)],
                fill=WHITE, width=line_w, joint="curve",
            )
        else:
            # квадратный маркер (пустой чекбокс)
            draw.rectangle(
                [bx, y - bullet, bx + bullet * 2 - line_w, y + bullet],
                outline=WHITE, width=line_w,
            )
        draw.line([(text_left, y), (text_right, y)], fill=WHITE, width=line_w)


def make_logo(path, width, height):
    scale = 4  # рисуем в 4x и уменьшаем для сглаживания
    w, h = width * scale, height * scale
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    radius = min(w, h) // 8
    draw.rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=BLUE)

    icon_size = int(min(w, h) * 0.5)
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
