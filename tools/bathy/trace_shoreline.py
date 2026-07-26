#!/usr/bin/env python3
"""Trace the shoreline from a WI DNR lake-map PDF and self-calibrate its scale.

These sheets carry no lat/long ticks, but they DO state the lake's area and
shoreline length. Tracing the shoreline in pixels and comparing against those
two printed figures yields the ft/px scale AND an independent check on it —
if the two disagree badly, the wrong outline was traced.

Why a simple flood fill works: the depth contours are interrupted wherever a
depth label sits on the line, so a fill seeded inside the lake leaks through
those gaps and spans the whole basin, stopping only at the (unbroken) shore.

Prefer the AREA-derived scale. Perimeter is inflated by pixel jaggedness (the
coastline effect), so it reads long; area is robust to it.

Usage:
  python3 tools/bathy/trace_shoreline.py <pdf> --seed X,Y --acres 1100 --shore-mi 6.3
"""
import argparse, json, sys, io

try:
    import fitz, cv2, numpy as np
    from PIL import Image
except ImportError as e:
    sys.exit(f"missing dep ({e}).  pip install pymupdf opencv-python-headless pillow")

ACRE_SQFT, MI_FT = 43560.0, 5280.0


def load_page_image(pdf, page=0):
    doc = fitz.open(pdf)
    imgs = doc[page].get_images(full=True)
    if not imgs:
        sys.exit("page has no embedded raster; this tool expects a scanned sheet")
    d = doc.extract_image(imgs[0][0])
    img = Image.open(io.BytesIO(d["image"])).convert("L")
    doc.close()
    return np.array(img)


def trace(gray, seed, crop_top, crop_bottom):
    ink = (gray < 128).astype(np.uint8)
    h0 = ink.shape[0]
    crop = ink[crop_top:h0 - crop_bottom, :]
    h, w = crop.shape
    # Light close: bridge label gaps in lines without welding the 5 ft contour
    # to the shoreline.
    ink_c = cv2.morphologyEx(crop, cv2.MORPH_CLOSE,
                             cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)), 1)
    water = (ink_c == 0).astype(np.uint8)
    sx, sy = seed
    if ink_c[sy, sx]:
        sys.exit(f"seed ({sx},{sy}) landed on ink; pick a point in open water")
    n, lab = cv2.connectedComponents(water, 8)
    basin = (lab == lab[sy, sx]).astype(np.uint8)
    basin = cv2.morphologyEx(basin, cv2.MORPH_CLOSE,
                             cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    # Fill anything the basin encloses (islands of contour lines, labels).
    inv = (basin == 0).astype(np.uint8)
    ff = inv.copy()
    cv2.floodFill(ff, np.zeros((h + 2, w + 2), np.uint8), (2, 2), 2)
    basin[ff == 1] = 1
    cs, _ = cv2.findContours(basin, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    return crop, max(cs, key=cv2.contourArea)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--seed", required=True, help="X,Y in open water, in cropped-image px")
    ap.add_argument("--acres", type=float, required=True, help="AREA printed on the sheet")
    ap.add_argument("--shore-mi", type=float, help="TOTAL SHORELINE printed on the sheet")
    ap.add_argument("--crop-top", type=int, default=150)
    ap.add_argument("--crop-bottom", type=int, default=260)
    ap.add_argument("--out", default="shoreline")
    a = ap.parse_args()
    seed = tuple(int(v) for v in a.seed.split(","))

    gray = load_page_image(a.pdf)
    crop, shore = trace(gray, seed, a.crop_top, a.crop_bottom)
    A = cv2.contourArea(shore)
    P = cv2.arcLength(shore, True)
    ft_px = (a.acres * ACRE_SQFT / A) ** 0.5

    print(f"image           : {gray.shape[1]}x{gray.shape[0]}  (cropped to {crop.shape[1]}x{crop.shape[0]})")
    print(f"shoreline       : {A:,.0f} px^2, {P:,.0f} px")
    print(f"scale (area)    : {ft_px:.3f} ft/px   <-- use this")
    if a.shore_mi:
        ft_px_p = a.shore_mi * MI_FT / P
        print(f"scale (perimeter): {ft_px_p:.3f} ft/px  ({100*abs(ft_px-ft_px_p)/ft_px:.1f}% apart)")
        print(f"traced shoreline : {P*ft_px/MI_FT:.2f} mi vs {a.shore_mi} mi printed"
              f"  ({100*(P*ft_px/MI_FT-a.shore_mi)/a.shore_mi:+.0f}%, jaggedness reads long)")
    x, y, w, h = cv2.boundingRect(shore)
    print(f"lake bbox       : {w*ft_px/MI_FT:.2f} x {h*ft_px/MI_FT:.2f} mi")

    pts = shore.reshape(-1, 2)
    simp = cv2.approxPolyDP(shore, 2.0, True).reshape(-1, 2)
    json.dump({"scale_ft_per_px": ft_px, "stated_acres": a.acres,
               "area_px2": A, "perimeter_px": P,
               "shoreline_px": simp.tolist(), "n_points_raw": len(pts)},
              open(f"{a.out}.json", "w"))
    vis = cv2.cvtColor((1 - crop) * 255, cv2.COLOR_GRAY2BGR)
    cv2.drawContours(vis, [shore], -1, (0, 0, 255), 6)
    cv2.imwrite(f"{a.out}.png", vis)
    print(f"wrote {a.out}.json ({len(simp)} pts simplified from {len(pts)}) and {a.out}.png")


if __name__ == "__main__":
    main()
