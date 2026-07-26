#!/usr/bin/env python3
"""Inspect a WI DNR lake-map PDF before attempting any digitization.

Everything about the pipeline depends on what this reports:

  * A real TEXT layer means depth labels and any lat/long tick marks can be
    read directly, with exact positions -- no OCR, which is the single biggest
    risk in tracing contours off a scan.
  * VECTOR drawings mean the contours themselves are already geometry and can
    be extracted as paths rather than traced from pixels.
  * If it is just one big embedded raster, we are georeferencing a scan and
    Tier B needs image processing plus human depth labels.

Usage:  python3 tools/bathy/inspect_pdf.py <file.pdf> [--dump-text N]
"""
import sys, collections

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit("PyMuPDF missing.  pip install pymupdf")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    path = sys.argv[1]
    dump = 40
    if "--dump-text" in sys.argv:
        dump = int(sys.argv[sys.argv.index("--dump-text") + 1])

    doc = fitz.open(path)
    print(f"file            : {path}")
    print(f"pages           : {doc.page_count}")
    print(f"pdf metadata    : { {k: v for k, v in (doc.metadata or {}).items() if v} }")

    for pno in range(doc.page_count):
        page = doc[pno]
        r = page.rect
        print(f"\n--- page {pno + 1} ---")
        print(f"size (pt)       : {r.width:.1f} x {r.height:.1f}"
              f"   ({r.width/72:.2f} x {r.height/72:.2f} in)")
        print(f"rotation        : {page.rotation}")

        # 1. Text layer -------------------------------------------------
        words = page.get_text("words")  # x0,y0,x1,y1,word,block,line,word_no
        print(f"text words      : {len(words)}")
        if words:
            numeric = [w for w in words if w[4].replace('.', '', 1).isdigit()]
            print(f"  numeric words : {len(numeric)}  <-- candidate DEPTH LABELS")
            # Coordinate-looking strings hint at georeferencing tick marks.
            geoish = [w for w in words if any(s in w[4] for s in ("°", "'", '"', "N", "W"))
                      and any(c.isdigit() for c in w[4])]
            print(f"  coord-ish     : {len(geoish)}  <-- candidate LAT/LONG TICKS")
            for w in geoish[:12]:
                print(f"      {w[4]!r} @ ({w[0]:.0f},{w[1]:.0f})")
            print(f"  first {dump} words:")
            for w in words[:dump]:
                print(f"      {w[4]!r} @ ({w[0]:.0f},{w[1]:.0f})")

        # 2. Vector drawings --------------------------------------------
        try:
            drawings = page.get_drawings()
        except Exception as e:
            drawings = []
            print(f"drawings        : FAILED ({e})")
        segs = collections.Counter()
        pts = 0
        for d in drawings:
            for item in d.get("items", []):
                segs[item[0]] += 1
                pts += sum(1 for x in item[1:] if hasattr(x, "x"))
        print(f"vector drawings : {len(drawings)} paths, segment types={dict(segs)}, ~{pts} points")
        if len(drawings) > 200:
            print("  ==> CONTOURS MAY ALREADY BE VECTORS -- extract paths, do not trace pixels")

        # 3. Embedded rasters -------------------------------------------
        imgs = page.get_images(full=True)
        print(f"embedded images : {len(imgs)}")
        for i, im in enumerate(imgs[:6]):
            xref, w, h, bpc, cs = im[0], im[2], im[3], im[4], im[5]
            print(f"      [{i}] xref={xref} {w}x{h} bpc={bpc} colorspace={cs}")
        if len(imgs) == 1 and not drawings:
            print("  ==> SINGLE SCAN: georeference the raster; Tier B needs tracing + human labels")

    doc.close()


if __name__ == "__main__":
    main()
