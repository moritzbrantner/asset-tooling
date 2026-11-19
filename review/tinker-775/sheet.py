"""sheet.py out.jpg cols label1=img1 label2=img2 ... : a labelled contact sheet."""
import sys
from PIL import Image, ImageDraw
out, cols, items = sys.argv[1], int(sys.argv[2]), [a.split("=", 1) for a in sys.argv[3:]]
ims = [(l, Image.open(p).convert("RGB")) for l, p in items]
w, h = ims[0][1].size
rows = (len(ims) + cols - 1) // cols
sheet = Image.new("RGB", (cols * w, rows * (h + 18)), (30, 30, 30))
d = ImageDraw.Draw(sheet)
for k, (l, im) in enumerate(ims):
    x, y = (k % cols) * w, (k // cols) * (h + 18)
    sheet.paste(im, (x, y + 18))
    d.text((x + 4, y + 3), l, fill=(230, 230, 230))
sheet.save(out, quality=85)
