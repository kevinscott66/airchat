"""Растеризация assets/logo/airchat-mark.svg без внешних утилит.

В окружении нет rsvg-convert/inkscape/cairosvg, а headless Chrome виснет на
повторных запусках. Геометрия марки — три отрезка со скруглёнными концами,
три узла и кольцо — повторяется здесь один в один с SVG, поэтому PNG и
вектор совпадают пиксель в пиксель. Сглаживание — суперсэмплингом.
"""
import os
from PIL import Image, ImageDraw

SP = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(SP)  # assets/
os.makedirs(OUT, exist_ok=True)

GROUND = (11, 11, 18)          # #0B0B12
G_FROM = (0xA5, 0x94, 0xFF)    # #A594FF
G_TO = (0x6A, 0x56, 0xEE)      # #6A56EE
G1, G2 = (120.0, 96.0), (392.0, 416.0)

SEGMENTS = [((256, 128), (128, 384)), ((256, 128), (384, 384)),
            ((160, 320), (224, 320)), ((288, 320), (352, 320))]
STROKE = 32
NODES = [(256, 128), (128, 384), (384, 384)]
NODE_R = 38
RING = (256, 320, 34, 14)      # cx, cy, внешний r, внутренний r


def build_mask(n, scale):
    """Маска марки в буфере n×n. scale — доля холста, занимаемая габаритом."""
    f = scale / (332 / 512) * n / 512          # viewBox → пиксели
    def P(p):
        return (n / 2 + (p[0] - 256) * f, n / 2 + (p[1] - 256) * f)
    m = Image.new("L", (n, n), 0)
    d = ImageDraw.Draw(m)
    half = STROKE / 2 * f
    for a, b in SEGMENTS:
        d.line([P(a), P(b)], fill=255, width=max(1, round(STROKE * f)))
        for p in (a, b):                       # скруглённые концы
            x, y = P(p)
            d.ellipse([x - half, y - half, x + half, y + half], fill=255)
    for p in NODES:
        x, y = P(p)
        r = NODE_R * f
        d.ellipse([x - r, y - r, x + r, y + r], fill=255)
    cx, cy, ro, ri = RING
    x, y = P((cx, cy))
    d.ellipse([x - ro * f, y - ro * f, x + ro * f, y + ro * f], fill=255)
    d.ellipse([x - ri * f, y - ri * f, x + ri * f, y + ri * f], fill=0)
    return m


def gradient(n, scale):
    f = scale / (332 / 512) * n / 512
    def P(p):
        return (n / 2 + (p[0] - 256) * f, n / 2 + (p[1] - 256) * f)
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


render("icon", 1024, 0.58, bg=GROUND)
render("android-icon-foreground", 1024, 0.44)
render("android-icon-background", 1024, 0, bg=GROUND)
render("android-icon-monochrome", 1024, 0.44, flat=(0, 0, 0))
render("splash-icon", 1024, 0.55)
render("favicon", 196, 0.66, bg=GROUND, ss=8)
render("logo/airchat-mark", 512, 0.90, ss=6)
