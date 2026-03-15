#!/usr/bin/env python3
"""
rmbg_sequence.py — Processa una sequenza di PNG in batch.
Carica il modello UNA VOLTA SOLA e processa tutti i frame in loop.
"""
import os, sys, json, argparse, traceback, glob, types, importlib.util
import safetensors.torch

def write_status(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input_dir",   required=True)
    ap.add_argument("--output_dir",  required=True)
    ap.add_argument("--pattern",     default="*.png")
    ap.add_argument("--process_py",  required=True)  # usato solo per trovare il server dir
    ap.add_argument("--python_exe",  required=True)   # non usato, mantenuto per compatibilità
    ap.add_argument("--model",       default="RMBG-2.0")
    ap.add_argument("--comfyui",     default=None)
    ap.add_argument("--mask_expand", type=float, default=0.0)
    ap.add_argument("--mask_blur",   type=float, default=0.0)
    ap.add_argument("--invert",      action="store_true")
    ap.add_argument("--save_matte",  action="store_true")
    ap.add_argument("--status",      required=True)
    args = ap.parse_args()

    write_status(args.status, {"status": "starting", "progress": "Inizializzazione…"})

    try:
        import torch
        import numpy as np
        from PIL import Image, ImageFilter
        from torchvision import transforms
        from transformers import PreTrainedModel

        device = ("cuda" if torch.cuda.is_available()
                  else "mps" if torch.backends.mps.is_available()
                  else "cpu")
        print(f"[SEQ] Device: {device}", flush=True)

        # ── Trova ComfyUI ────────────────────────────────────────
        root = args.comfyui
        if not root or not os.path.isdir(root):
            for c in [r"D:\NewComfy\ComfyUI-Easy-Install\ComfyUI",
                      os.path.expanduser("~/ComfyUI"), r"C:\ComfyUI"]:
                if os.path.isdir(c): root = c; break
        if not root or not os.path.isdir(root):
            raise RuntimeError(f"ComfyUI non trovato: {root}")

        # ── Percorso modello ─────────────────────────────────────
        mdir = os.path.join(root, "models")
        MODEL_MAP = {
            "RMBG-2.0":            (["RMBG/RMBG-2.0",  "rmbg/RMBG-2.0"],  None),
            "BiRefNet-general":    (["RMBG/BiRefNet",   "RMBG/BiRefNet-general"], "BiRefNet-general.safetensors"),
            "BiRefNet-HR":         (["RMBG/BiRefNet",   "RMBG/BiRefNet-HR"],      "BiRefNet-HR.safetensors"),
            "BiRefNet-HR-matting": (["RMBG/BiRefNet",   "RMBG/BiRefNet-HR-matting"], "BiRefNet-HR-matting.safetensors"),
        }
        dirs, weights_file = MODEL_MAP.get(args.model, (["RMBG/RMBG-2.0"], None))
        model_path = None
        for rel in dirs:
            full = os.path.join(mdir, rel)
            if os.path.isdir(full):
                model_path = full; break
        if not model_path:
            raise FileNotFoundError(f"Modello '{args.model}' non trovato in {mdir}")

        # ── Carica modello UNA VOLTA SOLA ────────────────────────
        write_status(args.status, {"status": "starting", "progress": f"Caricamento {args.model}…"})

        birefnet_path       = os.path.join(model_path, "birefnet.py")
        BiRefNetConfig_path = os.path.join(model_path, "BiRefNet_config.py")
        _weights_override   = os.path.join(model_path, weights_file) if weights_file else None

        config_spec = importlib.util.spec_from_file_location("BiRefNetConfig", BiRefNetConfig_path)
        config_module = importlib.util.module_from_spec(config_spec)
        sys.modules["BiRefNetConfig"] = config_module
        sys.modules["BiRefNet_config"] = config_module
        config_spec.loader.exec_module(config_module)

        if model_path not in sys.path:
            sys.path.insert(0, model_path)

        with open(birefnet_path, "r", encoding="utf-8") as f:
            birefnet_content = f.read()
        birefnet_content = birefnet_content.replace(
            "from .BiRefNet_config import BiRefNetConfig", "from BiRefNet_config import BiRefNetConfig")
        birefnet_content = birefnet_content.replace(
            "from .BiRefNet_config import", "from BiRefNet_config import")
        birefnet_content = birefnet_content.replace(
            "from . import BiRefNet_config", "import BiRefNet_config")

        module_name = f"custom_birefnet_seq_{hash(birefnet_path)}"
        module = types.ModuleType(module_name)
        sys.modules[module_name] = module
        exec(birefnet_content, module.__dict__)

        net = None
        for attr_name in dir(module):
            attr = getattr(module, attr_name)
            if isinstance(attr, type) and issubclass(attr, PreTrainedModel) and attr is not PreTrainedModel:
                BiRefNetConfig = getattr(config_module, "BiRefNetConfig")
                net = attr(BiRefNetConfig())
                wp = _weights_override if (_weights_override and os.path.isfile(_weights_override)) \
                     else os.path.join(model_path, "model.safetensors")
                print(f"[SEQ] Pesi: {os.path.basename(wp)}", flush=True)
                net.load_state_dict(safetensors.torch.load_file(wp))
                break

        if net is None:
            raise RuntimeError("Nessuna classe PreTrainedModel trovata in birefnet.py")

        net.eval()
        for p in net.parameters(): p.requires_grad = False
        import torch as _torch
        _torch.set_float32_matmul_precision("high")
        net.to(device)
        print(f"[SEQ] Modello caricato su {device}", flush=True)

        # ── Trasformazione input ─────────────────────────────────
        tf = transforms.Compose([
            transforms.Resize((1024, 1024)),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ])

        # ── Trova file da processare ─────────────────────────────
        files = sorted(glob.glob(os.path.join(args.input_dir, args.pattern)))
        if not files:
            raise FileNotFoundError(f"Nessun file in {args.input_dir} con pattern {args.pattern}")

        os.makedirs(args.output_dir, exist_ok=True)
        total = len(files)
        print(f"[SEQ] {total} frame", flush=True)

        # ── Loop frame ───────────────────────────────────────────
        errors = []
        for i, src_path in enumerate(files):
            fname = os.path.basename(src_path)
            out_path = os.path.join(args.output_dir, fname)

            write_status(args.status, {
                "status":   "processing",
                "progress": f"{i+1}/{total} — {fname}",
                "total":    total,
                "done":     i,
            })
            print(f"[SEQ] {i+1}/{total}: {fname}", flush=True)

            try:
                img = Image.open(src_path).convert("RGB")
                ow, oh = img.size
                inp = tf(img).unsqueeze(0).to(device)

                with _torch.no_grad():
                    preds = net(inp)
                    if isinstance(preds, list):
                        pred = preds[-1].sigmoid().squeeze().cpu()
                    elif isinstance(preds, dict) and "logits" in preds:
                        pred = preds["logits"].sigmoid().squeeze().cpu()
                    else:
                        pred = preds.sigmoid().squeeze().cpu()

                import numpy as np
                mask = transforms.ToPILImage()(pred).resize((ow, oh), Image.LANCZOS)
                mask_np = np.array(mask)

                # Post-processing
                from PIL import ImageFilter
                mp = Image.fromarray(mask_np)
                expand = args.mask_expand
                if expand > 0:
                    for _ in range(int(expand)):
                        mp = mp.filter(ImageFilter.MaxFilter(3))
                    if (expand - int(expand)) >= 0.5:
                        mp = mp.filter(ImageFilter.MaxFilter(3))
                elif expand < 0:
                    for _ in range(int(abs(expand))):
                        mp = mp.filter(ImageFilter.MinFilter(3))
                    if (abs(expand) - int(abs(expand))) >= 0.5:
                        mp = mp.filter(ImageFilter.MinFilter(3))
                if args.mask_blur > 0:
                    mp = mp.filter(ImageFilter.GaussianBlur(args.mask_blur))
                if args.invert:
                    mp = Image.fromarray(255 - np.array(mp))
                mask_np = np.array(mp)

                img_np = np.array(img)
                rgba = np.dstack([img_np[:, :, :3], mask_np])
                Image.fromarray(rgba.astype("uint8"), "RGBA").save(out_path)

                if args.save_matte:
                    matte_path = out_path.replace(".png", "_matte.png")
                    Image.fromarray(mask_np.astype("uint8"), "L").save(matte_path)

            except Exception as e:
                errors.append(f"{fname}: {e}")
                print(f"[SEQ] ERRORE {fname}: {e}", flush=True)

        status_data = {
            "status":     "done" if not errors else "done_with_errors",
            "output_dir": args.output_dir,
            "total":      total,
            "model":      args.model,
            "device":     str(device),
        }
        if errors:
            status_data["errors"] = errors[:5]
        write_status(args.status, status_data)
        print(f"[SEQ] DONE {total - len(errors)}/{total}", flush=True)

    except Exception as e:
        tb = traceback.format_exc()
        print(f"[SEQ] ERRORE:\n{tb}", flush=True)
        write_status(args.status, {"status": "error", "error": str(e), "traceback": tb})
        sys.exit(1)

if __name__ == "__main__":
    main()
