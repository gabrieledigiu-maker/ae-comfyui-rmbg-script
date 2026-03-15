#!/usr/bin/env python3
"""
rmbg_adjust.py — Applica expand/blur sulla maschera di un PNG già elaborato.
Niente GPU, solo PIL. Esecuzione in <500ms.
"""
import os, sys, json, argparse, traceback
from PIL import Image, ImageFilter
import numpy as np

def write_status(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input",       required=True,  help="PNG RGBA sorgente (output di rmbg_process)")
    ap.add_argument("--output",      required=True,  help="PNG RGBA destinazione (può essere uguale a input)")
    ap.add_argument("--mask_expand", type=float, default=0.0)
    ap.add_argument("--mask_blur",   type=float, default=0.0)
    ap.add_argument("--invert",      action="store_true")
    ap.add_argument("--status",      required=True)
    args = ap.parse_args()

    write_status(args.status, {"status": "processing", "progress": "Regolazione maschera..."})
    try:
        img = Image.open(args.input).convert("RGBA")
        r, g, b, a = img.split()

        mask = a
        # expand/blur ora sono float con step 0.5
        # Per expand usiamo MaxFilter(3) ripetuto N volte — 1 pixel per iterazione
        expand = args.mask_expand  # es. 2.5 → arrotondato a 2 o 3
        if expand > 0:
            full  = int(expand)
            frac  = expand - full
            for _ in range(full):
                mask = mask.filter(ImageFilter.MaxFilter(3))
            if frac >= 0.5:
                mask = mask.filter(ImageFilter.MaxFilter(3))
        elif expand < 0:
            full = int(abs(expand))
            frac = abs(expand) - full
            for _ in range(full):
                mask = mask.filter(ImageFilter.MinFilter(3))
            if frac >= 0.5:
                mask = mask.filter(ImageFilter.MinFilter(3))
        # blur accetta float direttamente
        if args.mask_blur > 0:
            mask = mask.filter(ImageFilter.GaussianBlur(args.mask_blur))
        if args.invert:
            mask = Image.fromarray(255 - np.array(mask))

        result = Image.merge("RGBA", (r, g, b, mask))
        result.save(args.output)

        write_status(args.status, {"status": "done", "output": args.output})
        print("[ADJUST] DONE", flush=True)

    except Exception as e:
        write_status(args.status, {"status": "error", "error": str(e), "traceback": traceback.format_exc()})
        sys.exit(1)

if __name__ == "__main__":
    main()
