#!/usr/bin/env python3
"""
SAM3 Batch Processor – processes all frames exported from After Effects
and returns them as PNG with alpha channel.

Usage:
    python batch_process.py --input /path/to/frames --output /path/to/output
                            [--model sam3_l] [--comfyui ~/ComfyUI]
"""

import os
import sys
import argparse
import json
import base64
import urllib.request
from pathlib import Path

SERVER_URL = "http://127.0.0.1:9876"


def encode_image(path: str) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def process_frame(image_path: str, params: dict) -> dict:
    payload = {
        "image": encode_image(image_path),
        **params,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{SERVER_URL}/remove_background",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input",   required=True,  help="Input frames directory")
    parser.add_argument("--output",  required=True,  help="Output directory for RGBA PNGs")
    parser.add_argument("--model",   default="sam3_l", choices=["sam3_l","sam3_l_hq","sam3_b_plus","sam3_b_plus_hq","sam3_s","sam3_t"])
    parser.add_argument("--confidence",  type=float, default=0.5)
    parser.add_argument("--mask_expand", type=int,   default=0)
    parser.add_argument("--mask_blur",   type=int,   default=0)
    parser.add_argument("--invert",      action="store_true")
    parser.add_argument("--ext",    default=".png", help="Input file extension")
    args = parser.parse_args()

    in_dir  = Path(args.input)
    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    frames = sorted(in_dir.glob(f"*{args.ext}"))
    if not frames:
        print(f"No {args.ext} files found in {in_dir}")
        sys.exit(1)

    params = {
        "model":        args.model,
        "prompt_type":  "auto",
        "confidence":   args.confidence,
        "mask_expand":  args.mask_expand,
        "mask_blur":    args.mask_blur,
        "invert_mask":  args.invert,
    }

    print(f"Processing {len(frames)} frames with model={args.model} …")
    for i, frame in enumerate(frames, 1):
        out_path = out_dir / (frame.stem + "_nobg.png")
        if out_path.exists():
            print(f"  [{i}/{len(frames)}] SKIP (exists): {out_path.name}")
            continue
        try:
            result = process_frame(str(frame), params)
            if result.get("success"):
                img_data = base64.b64decode(result["rgba_image"])
                with open(out_path, "wb") as f:
                    f.write(img_data)
                print(f"  [{i}/{len(frames)}] OK  → {out_path.name}")
            else:
                print(f"  [{i}/{len(frames)}] FAIL: {result.get('error','unknown error')}")
        except Exception as e:
            print(f"  [{i}/{len(frames)}] ERROR: {e}")

    print("Done.")


if __name__ == "__main__":
    main()
