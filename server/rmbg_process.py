#!/usr/bin/env python3
"""
rmbg_process.py — Processore standalone per After Effects
Usa ESATTAMENTE lo stesso codice di caricamento di AILab_RMBG.py (ComfyUI-RMBG).
"""

import os, sys, json, argparse, traceback, types, importlib.util
import safetensors.torch

def write_status(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input",       required=True)
    ap.add_argument("--output",      required=True)
    ap.add_argument("--model",       default="RMBG-2.0")
    ap.add_argument("--comfyui",     default=None)
    ap.add_argument("--status",      required=True)
    ap.add_argument("--mask_expand", type=float, default=0.0)
    ap.add_argument("--mask_blur",   type=float, default=0.0)
    ap.add_argument("--invert",      action="store_true")
    ap.add_argument("--save_matte",  action="store_true")
    ap.add_argument("--keep_input",  action="store_true", help="Non cancellare il file input (usato in modalità sequenza)")
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
        print(f"[RMBG] Device: {device}", flush=True)

        # ── Trova ComfyUI ────────────────────────────────────
        root = args.comfyui
        if not root or not os.path.isdir(root):
            for c in [r"D:\NewComfy\ComfyUI-Easy-Install\ComfyUI",
                      os.path.expanduser("~/ComfyUI"), r"C:\ComfyUI"]:
                if os.path.isdir(c): root = c; break
        if not root or not os.path.isdir(root):
            raise RuntimeError(f"ComfyUI non trovato: {root}")

        # ── Percorso modello ──────────────────────────────────
        mdir = os.path.join(root, "models")

        # Mappa modello → (cartella, file safetensors specifico o None per auto)
        MODEL_MAP = {
            "RMBG-2.0":              (["RMBG/RMBG-2.0",   "rmbg/RMBG-2.0"],  None),
            "BiRefNet-general":      (["RMBG/BiRefNet",    "RMBG/BiRefNet-general"], "BiRefNet-general.safetensors"),
            "BiRefNet-HR":           (["RMBG/BiRefNet",    "RMBG/BiRefNet-HR"],      "BiRefNet-HR.safetensors"),
            "BiRefNet-HR-matting":   (["RMBG/BiRefNet",    "RMBG/BiRefNet-HR-matting"], "BiRefNet-HR-matting.safetensors"),
        }
        dirs, weights_file = MODEL_MAP.get(args.model, (["RMBG/RMBG-2.0"], None))

        model_path = None
        for rel in dirs:
            full = os.path.join(mdir, rel)
            if os.path.isdir(full):
                model_path = full; break
        if not model_path:
            raise FileNotFoundError(f"Modello '{args.model}' non trovato in {mdir}")

        # Se il modello usa un file safetensors specifico, verifica che esista
        if weights_file:
            wf_path = os.path.join(model_path, weights_file)
            if not os.path.isfile(wf_path):
                raise FileNotFoundError(f"Peso '{weights_file}' non trovato in {model_path}")
        print(f"[RMBG] Modello: {model_path}" + (f" ({weights_file})" if weights_file else ""), flush=True)

        # ── Carica immagine ───────────────────────────────────
        write_status(args.status, {"status": "processing", "progress": "Caricamento immagine…"})
        img = Image.open(args.input).convert("RGB")
        ow, oh = img.size
        print(f"[RMBG] Immagine: {ow}x{oh}", flush=True)

        # ── Carica modello — IDENTICO a AILab_RMBG.py ─────────
        write_status(args.status, {"status": "processing", "progress": f"Caricamento {args.model}…"})

        birefnet_path       = os.path.join(model_path, "birefnet.py")
        BiRefNetConfig_path = os.path.join(model_path, "BiRefNet_config.py")
        # Per BiRefNet multi-model: il file di pesi specifico è in weights_file
        _weights_override = os.path.join(model_path, weights_file) if weights_file else None

        # 1. Carica BiRefNetConfig
        config_spec = importlib.util.spec_from_file_location("BiRefNetConfig", BiRefNetConfig_path)
        config_module = importlib.util.module_from_spec(config_spec)
        sys.modules["BiRefNetConfig"] = config_module
        # Registra anche come "BiRefNet_config" (nome usato da BiRefNet-HR)
        sys.modules["BiRefNet_config"] = config_module
        config_spec.loader.exec_module(config_module)

        # 2. Aggiungi model_path a sys.path — così qualsiasi import dal file funziona
        if model_path not in sys.path:
            sys.path.insert(0, model_path)

        # Leggi e patcha birefnet.py
        with open(birefnet_path, "r", encoding="utf-8") as f:
            birefnet_content = f.read()
        # Patch import relativi → assoluti (varie forme usate dai diversi modelli)
        birefnet_content = birefnet_content.replace(
            "from .BiRefNet_config import BiRefNetConfig",
            "from BiRefNet_config import BiRefNetConfig"
        )
        birefnet_content = birefnet_content.replace(
            "from .BiRefNet_config import",
            "from BiRefNet_config import"
        )
        birefnet_content = birefnet_content.replace(
            "from . import BiRefNet_config",
            "import BiRefNet_config"
        )

        # 3. Esegui in un modulo temporaneo
        module_name = f"custom_birefnet_model_{hash(birefnet_path)}"
        module = types.ModuleType(module_name)
        sys.modules[module_name] = module
        exec(birefnet_content, module.__dict__)

        # 4. Trova la classe che estende PreTrainedModel
        model = None
        for attr_name in dir(module):
            attr = getattr(module, attr_name)
            if (isinstance(attr, type)
                    and issubclass(attr, PreTrainedModel)
                    and attr is not PreTrainedModel):
                BiRefNetConfig = getattr(config_module, "BiRefNetConfig")
                model_config   = BiRefNetConfig()
                model = attr(model_config)

                # 5. Carica pesi — usa file specifico se indicato, altrimenti model.safetensors
                weights_path = _weights_override if (_weights_override and os.path.isfile(_weights_override))                                else os.path.join(model_path, "model.safetensors")
                print(f"[RMBG] Pesi: {os.path.basename(weights_path)}", flush=True)
                model.load_state_dict(safetensors.torch.load_file(weights_path))
                break

        if model is None:
            raise RuntimeError("Nessuna classe PreTrainedModel trovata in birefnet.py")

        model.eval()
        for param in model.parameters():
            param.requires_grad = False
        import torch
        torch.set_float32_matmul_precision("high")
        model.to(device)
        print(f"[RMBG] Modello caricato su {device}", flush=True)

        # ── Inferenza ─────────────────────────────────────────
        write_status(args.status, {"status": "processing", "progress": "Elaborazione GPU…"})

        tf = transforms.Compose([
            transforms.Resize((1024, 1024)),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ])
        inp = tf(img).unsqueeze(0).to(device)

        with torch.no_grad():
            preds = model(inp)
            # Gestisce sia list che tensor come output (stesso di AILab_RMBG.py)
            if isinstance(preds, list):
                pred = preds[-1].sigmoid().squeeze().cpu()
            elif isinstance(preds, dict) and "logits" in preds:
                pred = preds["logits"].sigmoid().squeeze().cpu()
            else:
                pred = preds.sigmoid().squeeze().cpu()

        mask_pil = transforms.ToPILImage()(pred).resize((ow, oh), Image.LANCZOS)
        mask_np  = np.array(mask_pil)

        # ── Post-processing ───────────────────────────────────
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
        mask_np = np.array(mp)
        if args.invert:
            mask_np = 255 - mask_np

        # ── Salva RGBA ────────────────────────────────────────
        write_status(args.status, {"status": "saving", "progress": "Salvataggio…"})
        img_np = np.array(img)
        rgba   = np.dstack([img_np[:, :, :3], mask_np])
        Image.fromarray(rgba.astype("uint8"), "RGBA").save(args.output)
        print(f"[RMBG] Salvato: {args.output}", flush=True)

        # Salva matte B/N se richiesto
        matte_path = None
        if args.save_matte:
            matte_path = args.output.replace(".png", "_matte.png")
            Image.fromarray(mask_np.astype("uint8"), "L").save(matte_path)
            print(f"[RMBG] Matte salvato: {matte_path}", flush=True)

        # ── Pulizia file temporanei ───────────────────────────
        if not args.keep_input:
            try:
                if os.path.isfile(args.input):
                    os.remove(args.input)
                    print(f"[RMBG] Rimosso temp: {args.input}", flush=True)
            except Exception:
                pass

        write_status(args.status, {
            "status":     "done",
            "output":     args.output,
            "matte_path": matte_path,
            "model":      args.model,
            "device":     str(device),
            "width":      ow,
            "height":     oh,
        })
        print("[RMBG] DONE", flush=True)

    except Exception as e:
        tb = traceback.format_exc()
        print(f"[RMBG] ERRORE:\n{tb}", flush=True)
        write_status(args.status, {"status": "error", "error": str(e), "traceback": tb})
        sys.exit(1)

if __name__ == "__main__":
    main()
