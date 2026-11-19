"""sheet.py out.jpg cols img1 img2 ... : a contact sheet labelled with each image's file name."""
import os
import sys

from PIL import Image, ImageDraw

out, cols, paths = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
ims = [(os.path.splitext(os.path.basename(p))[0], Image.open(p).convert("RGB")) for p in paths]
w, h = ims[0][1].size
rows = (len(ims) + cols - 1) // cols
sheet = Image.new("RGB", (cols * w, rows * (h + 18)), (30, 30, 30))
d = ImageDraw.Draw(sheet)
for k, (label, im) in enumerate(ims):
    x, y = (k % cols) * w, (k // cols) * (h + 18)
    sheet.paste(im, (x, y + 18))
    d.text((x + 4, y + 3), label, fill=(230, 230, 230))
sheet.save(out, quality=85)
