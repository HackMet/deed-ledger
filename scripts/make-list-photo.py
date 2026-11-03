#!/usr/bin/env python3
"""Draws scripts/sim-media/lista-once.jpg: a synthetic ruled-paper shopping list, 11 items, no
quantities, the last one ("sal") cut by the bottom edge of the photo. Run: python3 scripts/make-list-photo.py"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ITEMS = ["arroz", "frijoles", "azucar", "cafe", "leche", "huevos", "jabon", "pan", "aceite", "cebolla", "sal"]
W, H = 900, 1200
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf"
OUT = Path(__file__).parent / "sim-media" / "lista-once.jpg"

page = Image.new("RGB", (W + 160, H + 160), (58, 52, 48))
paper = Image.new("RGB", (W, H), (246, 241, 228))
d = ImageDraw.Draw(paper)
for y in range(110, H, 70):
    d.line([(40, y), (W - 20, y)], fill=(176, 192, 228), width=2)
d.line([(110, 0), (110, H)], fill=(222, 140, 140), width=2)
font = ImageFont.truetype(FONT, 50)
d.text((140, 40), "Mandado", font=font, fill=(24, 32, 112))
# Items sit on the ruled lines; the last one is half below the page's bottom edge.
step = 82
top = 150
for i, item in enumerate(ITEMS):
    y = top + i * step
    if i == len(ITEMS) - 1:
        y = H - 28
    d.text((140, y), f"- {item}", font=font, fill=(24, 32, 112))
page.paste(paper.rotate(-2, expand=False, fillcolor=(58, 52, 48)), (80, 80))
page.crop((80, 80, 80 + W, 80 + H)).save(OUT, quality=82)
