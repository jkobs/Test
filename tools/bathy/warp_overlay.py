#!/usr/bin/env python3
"""Warp an aligned lake-survey scan to a north-up overlay for Leaflet.

Takes the transform emitted by tools/align (centre, rotation, ft/px and the
four sheet corners in lat/lon) and produces an axis-aligned RGBA PNG plus the
lat/lon bounds L.imageOverlay needs.

The sheet's four corners give a plain affine from pixel space to lat/lon, so
the warp is exact up to the Mercator-vs-plate-carree difference, which over a
~5 km lake is sub-metre — far below the accuracy of a 1960 hand-drawn survey.

Usage:
  python3 warp_overlay.py scan.pdf xform.json --shore shore.npy --out cedar_geo
"""
import argparse, io, json, sys
import numpy as np

try:
    import cv2, fitz
    from PIL import Image
except ImportError as e:
    sys.exit(f"missing dep ({e}); pip install pymupdf opencv-python-headless pillow")

FT_PER_DEG_LAT = 364000.0


def page_image(pdf):
    doc = fitz.open(pdf)
    d = doc.extract_image(doc[0].get_images(full=True)[0][0])
    doc.close()
    return np.array(Image.open(io.BytesIO(d["image"])).convert("L"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf"); ap.add_argument("xform")
    ap.add_argument("--shore", help="shore.npy from trace_shoreline, used to crop")
    ap.add_argument("--crop-top", type=int, default=150)
    ap.add_argument("--crop-bottom", type=int, default=260)
    ap.add_argument("--margin-ft", type=float, default=400)
    ap.add_argument("--mask-to-shore", action="store_true",
                    help="keep only ink INSIDE the shoreline: drops roads, "
                         "title block and off-lake labels, which the app's own "
                         "basemap already provides")
    ap.add_argument("--out", default="cedar_geo")
    a = ap.parse_args()

    X = json.load(open(a.xform))
    W, H = X["image_px"]
    c = X["corners"]
    nw, ne, sw = c["nw"], c["ne"], c["sw"]

    # Axis-aligned bbox of the rotated sheet.
    lats = [v[0] for v in c.values()]; lons = [v[1] for v in c.values()]
    minlat, maxlat, minlon, maxlon = min(lats), max(lats), min(lons), max(lons)
    ftlon = FT_PER_DEG_LAT * np.cos(np.radians((minlat + maxlat) / 2))
    res = X["ft_per_px"]
    OW = int(round((maxlon - minlon) * ftlon / res))
    OH = int(round((maxlat - minlat) * FT_PER_DEG_LAT / res))

    def to_dest(lat, lon):
        return [(lon - minlon) * ftlon / res, (maxlat - lat) * FT_PER_DEG_LAT / res]

    src = np.float32([[0, 0], [W, 0], [0, H]])
    dst = np.float32([to_dest(*nw), to_dest(*ne), to_dest(*sw)])
    M = cv2.getAffineTransform(src, dst)
    print(f"sheet corners -> north-up raster {OW}x{OH} px at {res:.4f} ft/px")

    gray = page_image(a.pdf)
    ink = (gray < 128).astype(np.uint8)
    rgba = np.zeros((gray.shape[0], gray.shape[1], 4), np.uint8)
    rgba[..., 1] = 255; rgba[..., 2] = 255           # cyan ink
    rgba[..., 3] = ink * 255
    warped = cv2.warpAffine(rgba, M, (OW, OH), flags=cv2.INTER_NEAREST,
                            borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))

    x0, y0, x1, y1 = 0, 0, OW, OH
    if a.shore:
        sh = np.load(a.shore).reshape(-1, 2).astype(np.float32)
        sh[:, 1] += a.crop_top                        # tracer worked on a cropped image
        pts = cv2.transform(sh.reshape(-1, 1, 2), M).reshape(-1, 2)
        m = a.margin_ft / res
        x0 = max(0, int(pts[:, 0].min() - m)); x1 = min(OW, int(pts[:, 0].max() + m))
        y0 = max(0, int(pts[:, 1].min() - m)); y1 = min(OH, int(pts[:, 1].max() + m))
        print(f"cropping to lake + {a.margin_ft:.0f} ft margin: {x1-x0}x{y1-y0} px")
        if a.mask_to_shore:
            mask = np.zeros((OH, OW), np.uint8)
            cv2.fillPoly(mask, [pts.astype(np.int32)], 255)
            kept = int((warped[..., 3] > 0).sum())
            warped[..., 3] = (warped[..., 3] * (mask > 0)).astype(np.uint8)
            now = int((warped[..., 3] > 0).sum())
            print(f"masked to shoreline: kept {now:,} of {kept:,} ink px "
                  f"({100*now/max(1,kept):.0f}%) - roads and title block dropped")

    out = warped[y0:y1, x0:x1]
    north = maxlat - y0 * res / FT_PER_DEG_LAT
    south = maxlat - y1 * res / FT_PER_DEG_LAT
    west = minlon + x0 * res / ftlon
    east = minlon + x1 * res / ftlon

    Image.fromarray(out, "RGBA").save(f"{a.out}.png", optimize=True)
    bounds = [[round(south, 7), round(west, 7)], [round(north, 7), round(east, 7)]]
    json.dump({"lake": X["lake"], "bounds": bounds, "size_px": [out.shape[1], out.shape[0]],
               "ft_per_px": res, "rotation_applied_deg": X["rotation_deg"]},
              open(f"{a.out}.json", "w"), indent=1)
    import os
    print(f"bounds (SW,NE): {bounds}")
    print(f"wrote {a.out}.png ({os.path.getsize(a.out+'.png'):,} bytes) and {a.out}.json")


if __name__ == "__main__":
    main()
