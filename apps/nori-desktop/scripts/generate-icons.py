from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'build'
BUILD.mkdir(parents=True, exist_ok=True)

SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Nori N logo">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#202020"/>
      <stop offset="1" stop-color="#0f0f0f"/>
    </linearGradient>
    <linearGradient id="mark" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#d8ddd9"/>
    </linearGradient>
  </defs>
  <rect x="48" y="48" width="928" height="928" rx="232" fill="url(#bg)"/>
  <rect x="49.5" y="49.5" width="925" height="925" rx="230.5" fill="none" stroke="#3a3a3a" stroke-width="3"/>
  <path d="M274 742V282c0-38 31-69 69-69h22c24 0 47 13 60 33l230 350V282c0-38 31-69 69-69s69 31 69 69v460c0 38-31 69-69 69h-18c-25 0-48-13-61-34L412 424v318c0 38-31 69-69 69s-69-31-69-69Z" fill="url(#mark)"/>
  <circle cx="793" cy="213" r="34" fill="#9be8b0"/>
</svg>\n'''
(BUILD / 'icon.svg').write_text(SVG, encoding='utf-8')

S = 4096
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
scale = S / 1024

def box(v): return tuple(round(x * scale) for x in v)
# background and subtle border
d.rounded_rectangle(box((48, 48, 976, 976)), radius=round(232*scale), fill=(19,19,19,255), outline=(58,58,58,255), width=round(4*scale))
# geometric N, rendered at high resolution for clean downsampling
white = (244, 246, 244, 255)
d.rounded_rectangle(box((274, 213, 412, 811)), radius=round(69*scale), fill=white)
d.rounded_rectangle(box((655, 213, 793, 811)), radius=round(69*scale), fill=white)
d.polygon([box((342,213))[0:2], box((445,213))[0:2], box((725,811))[0:2], box((622,811))[0:2]], fill=white)
# mask tiny edge joins with circles
# accent: a small Nori-green status seed in the top-right
d.ellipse(box((759,179,827,247)), fill=(155,232,176,255))

resample = Image.Resampling.LANCZOS
png = img.resize((1024, 1024), resample)
png.save(BUILD / 'icon.png', optimize=True)
# Windows icon includes every shell/installer size.
png.save(BUILD / 'icon.ico', format='ICO', sizes=[(16,16),(20,20),(24,24),(32,32),(40,40),(48,48),(64,64),(128,128),(256,256)])
# Pillow writes a multi-resolution Apple icon family.
png.save(BUILD / 'icon.icns', format='ICNS', append_images=[png.resize((s,s), resample) for s in (16,32,64,128,256,512)])
print('generated', *(str(BUILD / f'icon.{ext}') for ext in ('svg','png','ico','icns')), sep='\n')
