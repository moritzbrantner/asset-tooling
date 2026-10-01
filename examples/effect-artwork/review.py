"""Inspect the actual PNG ingredients on light, dark and checkerboard backdrops."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[2]
folder = root / ".artifacts/effect-artwork"
board = Image.new("RGB", (960, 620), "#e8e6df")
draw = ImageDraw.Draw(board)
draw.text((24, 14), "Static ingredient pixels - original 64px PNG enlarged 2x / no motion evaluator", fill="#222222")
for row, shape in enumerate(("puff", "ring")):
    for col, intensity in enumerate(("subtle", "strong", "off")):
        left, top = 20 + col * 312, 45 + row * 280
        draw.text((left, top), f"{shape} / {intensity}", fill="#222222")
        image = Image.open(folder / f"{shape}.{intensity}.png").convert("RGBA").resize((128, 128), Image.Resampling.NEAREST)
        for backdrop, color in enumerate(("#fdfbf7", "#192731")):
            bg = Image.new("RGBA", (128, 128), color)
            bg.alpha_composite(image)
            board.paste(bg.convert("RGB"), (left + backdrop * 140, top + 24))
        checker = Image.new("RGBA", (128, 96), "#eeeeee")
        check_draw = ImageDraw.Draw(checker)
        for y in range(0, 96, 8):
            for x in range(0, 128, 8):
                if (x // 8 + y // 8) % 2:
                    check_draw.rectangle((x, y, x + 7, y + 7), fill="#d2d2d2")
        checker.alpha_composite(image, (0, -16))
        board.paste(checker.convert("RGB"), (left, top + 166))
board.save(folder / "review.png")
