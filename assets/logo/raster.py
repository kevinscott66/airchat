"""Растеризация assets/logo/airchat-mark.svg без внешних утилит.

В окружении нет rsvg-convert/inkscape/cairosvg, а headless Chrome виснет на
повторных запусках. Марка — два контура с квадратичными кривыми, поэтому здесь
они читаются прямо из SVG и заливаются полигоном по достаточно частой выборке:
PNG и вектор совпадают, потому что источник у них один файл, а не две копии
геометрии. Сглаживание — суперсэмплингом.

Дырка в реплике — второй подконтур того же `d`, обойдённый в обратную сторону:
в SVG её делает правило nonzero, здесь — заливка нулём поверх первого контура.
Порядок важен: хвост рисуется после, иначе дырка съела бы его основание.
"""
import os
import re
from PIL import Image, ImageDraw

SP = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(SP)  # assets/
os.makedirs(OUT, exist_ok=True)

GROUND = (11, 11, 18)          # #0B0B12
SVG = open(os.path.join(SP, 'airchat-mark.svg'), encoding='utf-8').read()
G_FROM, G_TO = (0xA5, 0x94, 0xFF), (0x6A, 0x56, 0xEE)
G1 = (float(re.search(r'x1="([\d.]+)"', SVG)[1]), float(re.search(r'y1="([\d.]+)"', SVG)[1]))
G2 = (float(re.search(r'x2="([\d.]+)"', SVG)[1]), float(re.search(r'y2="([\d.]+)"', SVG)[1]))
VIEW = float(re.search(r'viewBox="0 0 (\d+)', SVG)[1])
PATHS = re.findall(r'<path d="([^"]+)"', SVG)

# Габарит чернил: марка кадрируется по нему, а не по полям файла.
INK = (127.4, 120.0, 392.9, 416.0)
CENTER = ((INK[0] + INK[2]) / 2, (INK[1] + INK[3]) / 2)
SPAN = max(INK[2] - INK[0], INK[3] - INK[1])


def contours(d, steps=48):
    """Подконтуры `d` как списки точек. Команды: M, L, Q, Z."""
    tokens = re.findall(r'[A-Za-z]|-?\d+(?:\.\d+)?', d)
    subs, pts, cur, start, cmd, i = [], [], None, None, None, 0
    def num():
        nonlocal i
        i += 1
        return float(tokens[i - 1])
    while i < len(tokens):
        if tokens[i].isalpha():
            cmd = tokens[i]
            i += 1
        if cmd == 'Z':
            if pts:
                subs.append(pts)
                pts = []
            cur = start
            if i < len(tokens) and not tokens[i].isalpha():
                cmd = 'L'
            else:
                continue
        if cmd == 'M':
            cur = start = (num(), num())
            pts.append(cur)
            cmd = 'L'
        elif cmd == 'L':
            cur = (num(), num())
            pts.append(cur)
        elif cmd == 'Q':
            cx, cy, ex, ey = num(), num(), num(), num()
            x0, y0 = cur
            for k in range(1, steps + 1):
                t = k / steps
                pts.append(((1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * ex,
                            (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * ey))
            cur = (ex, ey)
        else:
            raise ValueError('неизвестная команда контура: %r' % cmd)
    if pts:
        subs.append(pts)
    return subs


def place(n, scale):
    """Преобразование координат SVG в пиксели буфера n×n."""
    f = n * scale / SPAN
    return lambda p: (n / 2 + (p[0] - CENTER[0]) * f, n / 2 + (p[1] - CENTER[1]) * f)


def build_mask(n, scale):
    P = place(n, scale)
    m = Image.new("L", (n, n), 0)
    d = ImageDraw.Draw(m)
    for path in PATHS:
        for k, sub in enumerate(contours(path)):
            d.polygon([P(p) for p in sub], fill=0 if k % 2 else 255)
    return m


def gradient(n, scale):
    P = place(n, scale)
    ax, ay = P(G1)
    bx, by = P(G2)
    dx, dy = bx - ax, by - ay
    den = dx * dx + dy * dy
    img = Image.new("RGB", (n, n))
    px = img.load()
    for y in range(n):
        wy = (y - ay) * dy
        for x in range(n):
            t = ((x - ax) * dx + wy) / den
            t = 0.0 if t < 0 else (1.0 if t > 1 else t)
            px[x, y] = (round(G_FROM[0] + (G_TO[0] - G_FROM[0]) * t),
                        round(G_FROM[1] + (G_TO[1] - G_FROM[1]) * t),
                        round(G_FROM[2] + (G_TO[2] - G_FROM[2]) * t))
    return img


def render(name, size, scale, bg=None, flat=None, ss=4):
    n = size * ss
    if scale <= 0:
        img = Image.new("RGBA", (size, size), bg + (255,))
        img.save(os.path.join(OUT, name + ".png"))
        return
    mask = build_mask(n, scale).resize((size, size), Image.LANCZOS)
    fill = (Image.new("RGB", (size, size), flat) if flat
            else gradient(n, scale).resize((size, size), Image.LANCZOS))
    img = Image.new("RGBA", (size, size), (bg + (255,)) if bg else (0, 0, 0, 0))
    img.paste(fill.convert("RGBA"), (0, 0), mask)
    img.save(os.path.join(OUT, name + ".png"))
    print(name, size, os.path.getsize(os.path.join(OUT, name + ".png")))


render("icon", 1024, 0.62, bg=GROUND)
render("android-icon-foreground", 1024, 0.47)
render("android-icon-background", 1024, 0, bg=GROUND)
render("android-icon-monochrome", 1024, 0.47, flat=(0, 0, 0))
render("splash-icon", 1024, 0.58)
render("favicon", 196, 0.70, bg=GROUND, ss=8)
render("logo/airchat-mark", 512, 0.94, ss=6)
