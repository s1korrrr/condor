import json
from pathlib import Path

from PIL import Image, ImageDraw

root = Path(__file__).parent
index = json.loads((root / "screenshots/screenshot-index.json").read_text())
groups = {}
for record in index["records"]:
    groups.setdefault((record["name"], record["width"]), []).append(record)
destination = root / "sheets"
destination.mkdir(exist_ok=True)
for (name, width), records in groups.items():
    if len(records) != 3:
        continue
    panels = []
    for record in records:
        image = Image.open(record["path"]).convert("RGB")
        image.thumbnail((480, 16000))
        panel = Image.new("RGB", (500, image.height + 36), "#e5e7eb")
        ImageDraw.Draw(panel).text((10, 10), f"{name} {width} {record['theme']}", fill="black")
        panel.paste(image, (10, 32))
        panels.append(panel)
    sheet = Image.new("RGB", (1500, max(panel.height for panel in panels)), "#e5e7eb")
    for offset, panel in enumerate(panels):
        sheet.paste(panel, (offset * 500, 0))
    sheet.save(destination / f"{name}-{width}.png")
