#!/usr/bin/env python3
"""Lane B: deterministic synthetic E2 image renderer (PIL only, no AI images).

Renders each E2 case image_spec to spikes/cases/e2/img/<input.file basename>.
All content is synthetic Spanish paperwork per the case specs.
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), "..", "cases", "e2", "img")
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
SANS_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"

W, H = 1280, 960
INK = (20, 20, 20)
BLUE = (30, 60, 160)
GRAY = (120, 120, 120)


def font(path, size):
    return ImageFont.truetype(path, size)


def base():
    img = Image.new("RGB", (W, H), "white")
    return img, ImageDraw.Draw(img)


def invoice(rows, header_no, title="FACTURA", stain_total=None, note=None):
    img, d = base()
    f_title = font(SANS_B, 52)
    f_head = font(SANS, 30)
    f_row = font(MONO, 32)
    d.text((60, 40), title, fill=INK, font=f_title)
    d.text((60, 115), f"No. {header_no}    Fecha: 2026-10-27", fill=INK, font=f_head)
    d.text((60, 160), "Proveedor: Distribuidora El Centro (sintetico)", fill=GRAY, font=f_head)
    y = 260
    d.text((60, y), "Cant  Unidad   Descripcion            P.Unit", fill=INK, font=font(MONO, 30))
    y += 44
    d.line([(60, y), (W - 60, y)], fill=INK, width=2)
    y += 14
    for qty, unit, desc, price in rows:
        line = f"{qty:<5} {unit:<8} {desc:<24} {price}"
        d.text((60, y), line, fill=INK, font=f_row)
        y += 52
    d.line([(60, y), (W - 60, y)], fill=INK, width=2)
    y += 20
    if stain_total is not None:
        # totals box, then a coffee stain fully covering the total value
        d.text((60, y), f"TOTAL:  {stain_total}", fill=INK, font=font(MONO, 36))
        stain = Image.new("L", img.size, 0)
        sd = ImageDraw.Draw(stain)
        sd.ellipse([(190, y - 40), (760, y + 70)], fill=255)
        stain = stain.filter(ImageFilter.GaussianBlur(6))
        brown = Image.new("RGB", img.size, (139, 90, 43))
        img.paste(brown, (0, 0), stain)
        d = ImageDraw.Draw(img)
        # re-draw label text left of the stain
        d.rectangle([(60, y - 10), (330, y + 55)], fill="white")
        d.text((60, y), "TOTAL:", fill=INK, font=font(MONO, 36))
    if note:
        nx, ny, text = note
        d.text((nx, ny), text, fill=BLUE, font=font(SANS, 34))
    return img


def notebook():
    img = Image.new("RGB", (W, H), (255, 255, 250))
    d = ImageDraw.Draw(img)
    f = font(SANS, 44)
    for i in range(8):
        y = 120 + i * 80
        d.line([(40, y), (W - 40, y)], fill=(170, 200, 235), width=2)
    d.text((120, 250), "Coca 2L  ---  5", fill=BLUE, font=f)
    # 'Jugo --- 7' with the 7 smudged so it reads as 7 or 9: locate the
    # digit's bbox, then scribble semi-opaque ink strokes over it.
    d.text((120, 410), "Jugo  ---  7", fill=BLUE, font=f)
    full = "Jugo  ---  7"
    _, _, x1, _ = d.textbbox((120, 410), full, font=f)
    _, _, prefix_right, _ = d.textbbox((120, 410), full[:-1], font=f)
    digit = (prefix_right - 4, 405, x1 + 6, 490)  # bbox of the '7'
    ink_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    idraw = ImageDraw.Draw(ink_layer)
    # heavy rounded scribble over the digit: loop suggests 9, stem keeps 7
    idraw.ellipse([digit[0], digit[1], digit[2], digit[1] + 45],
                  fill=(30, 60, 160, 200))
    idraw.line([(digit[0] + 30, digit[1]), (digit[0] + 12, digit[3])],
               fill=(30, 60, 160, 220), width=9)
    idraw.line([(digit[0], digit[1] + 20), (digit[2], digit[1] + 34)],
               fill=(30, 60, 160, 170), width=7)
    img.paste(Image.alpha_composite(img.convert("RGBA"), ink_layer).convert("RGB"))
    return img


def price_list():
    img, d = base()
    f_title = font(SANS_B, 52)
    f_row = font(MONO, 36)
    d.text((60, 60), "LISTA DE PRECIOS", fill=INK, font=f_title)
    d.text((60, 140), "Precios por unidad. Sin cantidades.", fill=GRAY, font=font(SANS, 28))
    y = 260
    for desc, price in [("Harina 10 lb", "L120.00"), ("Aceite 1L", "L85.00"),
                        ("Sal 2 lb", "L18.00"), ("Café 1 lb", "L95.00")]:
        d.text((60, y), f"{desc:<22} {price}", fill=INK, font=f_row)
        y += 70
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = {
        "e2-01-printed-invoice.png": invoice(
            [("12", "caja", "Leche entera 1L x12", "L45.00"),
             ("4", "saco", "Arroz 25 lb", "L625.00"),
             ("10", "bolsa", "Azúcar 5 lb", "L98.00")],
            "000123"),
        "e2-02-notebook-page.png": notebook(),
        "e2-03-price-list.png": price_list(),
        "e2-04-stained-invoice.png": invoice(
            [("6", "caja", "Leche entera 1L", "L45.00"),
             ("8", "unidad", "Mantequilla 1 lb", "L32.00")],
            "000124", stain_total="L526.00"),
        "e2-05-promo-invoice.png": invoice(
            [("2", "caja", "Caja mixta 12", "L180.00"),
             ("2", "und", "Bono café (promo)", "")],
            "000125"),
        "e2-06-corrected-invoice.png": invoice(
            [("12", "caja", "Leche entera 1L", "L45.00"),
             ("4", "saco", "Arroz 25 lb", "L625.00")],
            "000126", note=(985, 306, "fueron 10")),
    }
    for name, img in jobs.items():
        img.save(os.path.join(OUT, name))
        print("wrote", name, img.size)


if __name__ == "__main__":
    main()
