import sys, os

print("=" * 50)
print("RMBG for AE - Test Setup")
print("=" * 50)
print()
print("Python:", sys.executable)
print("Versione:", sys.version.split()[0])
print()

# Test torch/CUDA
try:
    import torch
    print("PyTorch:", torch.__version__)
    print("CUDA disponibile:", torch.cuda.is_available())
    if torch.cuda.is_available():
        print("GPU:", torch.cuda.get_device_name(0))
        vram = torch.cuda.get_device_properties(0).total_memory / 1024**3
        print("VRAM:", round(vram, 1), "GB")
    else:
        print("!! CUDA non disponibile - usera CPU (molto lento)")
except ImportError as e:
    print("ERRORE torch:", e)

print()

# Test transformers
try:
    import transformers
    print("transformers:", transformers.__version__, "OK")
except ImportError as e:
    print("ERRORE transformers:", e)
    print("  Soluzione: pip install transformers")

# Test torchvision
try:
    import torchvision
    print("torchvision:", torchvision.__version__, "OK")
except ImportError as e:
    print("ERRORE torchvision:", e)

print()

# Cerca modelli
comfyui_candidates = [
    r"D:\NewComfy\ComfyUI-Easy-Install\ComfyUI",
    os.path.expanduser("~/ComfyUI"),
    r"C:\ComfyUI",
]
comfyui = None
for c in comfyui_candidates:
    if os.path.isdir(c):
        comfyui = c
        break

if comfyui:
    print("ComfyUI:", comfyui)
    mdir = os.path.join(comfyui, "models")
    for name, rel in [("RMBG-2.0", r"RMBG\RMBG-2.0"), ("SAM3", "sam3")]:
        path = os.path.join(mdir, rel)
        if os.path.isdir(path):
            files = os.listdir(path)
            print(f"  OK  {name}: {path}")
            for f in files[:3]:
                print(f"       - {f}")
        else:
            print(f"  !!  {name}: NON TROVATO ({path})")
else:
    print("ComfyUI non trovato!")

print()
input("Premi INVIO per chiudere...")
