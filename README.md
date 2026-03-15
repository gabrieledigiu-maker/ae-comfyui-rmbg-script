# RMBG for After Effects

**Run AI background removal directly inside After Effects — no switching apps, no manual exporting.**
Built for personal workflow experiments.

This script connects After Effects to the AI models you already have installed via [ComfyUI-RMBG](https://github.com/1038lab/ComfyUI-RMBG). Select a layer, click a button, get a clean RGBA result back in your timeline — GPU accelerated.

Works on single images and PNG sequences.

---
![demo](https://github.com/gabrieledigiu-maker/ae-comfyui-rmbg-script/blob/main/git.gif)


## Features

- ✅ One-click background removal from inside AE
- ✅ GPU accelerated (CUDA) — processes a PNG sequence in real-time
- ✅ Supports single images and full PNG sequences
- ✅ Live mask preview — adjust expand/blur without re-running the model
- ✅ Save B&W matte alongside the RGBA result
- ✅ Output saved next to your AE project, auto-imported into the timeline
- ✅ No separate server, no HTTP — pure file-based async communication

---

## Supported Models

All models are loaded directly from your existing ComfyUI installation.  
**If ComfyUI-RMBG already works for you, this script works too — no extra downloads needed.**

| Model | Folder in ComfyUI | License |
|---|---|---|
| **RMBG-2.0** | `models/RMBG/RMBG-2.0/` | Non-commercial only |
| **BiRefNet-general** | `models/RMBG/BiRefNet/` | Apache 2.0 ✓ |
| **BiRefNet-HR** | `models/RMBG/BiRefNet/` | Apache 2.0 ✓ |
| **BiRefNet-HR-matting** | `models/RMBG/BiRefNet/` | Apache 2.0 ✓ |

> **Note on RMBG-2.0:** Free for personal/non-commercial use only. For commercial projects use BiRefNet (Apache 2.0 — fully free).

---

## Requirements

| Requirement | Notes |
|---|---|
| After Effects | CC 2019 or later |
| ComfyUI | Already installed and working |
| ComfyUI-RMBG | Node installed, at least one model downloaded |
| Python | The one bundled with ComfyUI — no separate install needed |
| GPU (NVIDIA CUDA) | Strongly recommended. CPU works but is significantly slower |
| GPU (Apple Silicon) | Should work via MPS — not tested |
| OS | Windows ✅ tested &nbsp;/&nbsp; macOS ⚠ code present, not tested |

---

## Installation

### Step 1 — Copy the script files

Copy the **entire `server/` folder** and the **`jsx/` folder** to your After Effects Scripts directory:

**Windows:**
```
C:\Program Files\Adobe\Adobe After Effects <version>\Support Files\Scripts\
```

**macOS:**
```
/Applications/Adobe After Effects <version>/Scripts/
```

Your final structure should look like this:
```
Scripts/
├── jsx/
│   └── SAM3_BG_Remover.jsx
└── server/
    ├── rmbg_process.py
    ├── rmbg_sequence.py
    ├── rmbg_adjust.py
    └── ...
```

### Step 2 — Allow scripts to write files

In After Effects:  
**Edit → Preferences → Scripting & Expressions**  
→ Enable **"Allow Scripts to Write Files and Access Network"**

### Step 3 — Open the panel

In After Effects: **Window → SAM3_BG_Remover.jsx**

Dock it wherever you like.

### Step 4 — Set your ComfyUI path

In the panel, click **`…`** next to the ComfyUI path field and select your ComfyUI root folder.

**Example paths:**
- Windows: `D:\NewComfy\ComfyUI-Easy-Install\ComfyUI`
- macOS: `/Users/yourname/ComfyUI`

The script finds the bundled Python executable automatically.

---

## Usage

### Single image or video frame

1. Select a layer in your composition
2. Choose a model from the dropdown
3. Click **▶ Remove Background**
4. The result appears as a new RGBA layer above the original

Output is saved in a `RMBG/` subfolder next to your `.aep` project file.

### PNG sequence

1. Import your PNG sequence into AE (`File → Import`, check "PNG Sequence")
2. Add it to a comp and select the layer
3. Click **▶ Remove Background**
4. The script processes all frames in a single Python process — model loads once, loops through every frame on the GPU
5. The resulting sequence is automatically imported back into your project at the correct frame rate

**40 frames at 4K → ~30 seconds on an RTX 4080**

### Live mask adjustment

After the first render, the **Mask Expand** and **Mask Blur** sliders activate.  
Moving a slider re-applies the adjustment in ~200ms using CPU only — no GPU, no re-running the model.  
The layer in your comp updates automatically.

| Control | Effect |
|---|---|
| **Mask Expand** | Grow (+) or shrink (−) the mask edge, 0.5px steps |
| **Mask Blur** | Feather the mask edge |
| **Invert** | Select the background instead of the subject |
| **Save matte** | Also export a B&W alpha PNG for inspection |

---

## How it works

After Effects ExtendScript can't run Python directly. The panel:

1. Exports the current frame as a PNG to a temp folder
2. Generates a `.bat` + `.vbs` launcher to run Python invisibly in the background (Windows)
3. Polls a `status.json` file every 2 seconds to track progress
4. When Python writes `"status": "done"`, imports the result and adds it to the comp
5. Cleans up all temp files automatically

The Python scripts load model weights directly from `ComfyUI/models/RMBG/` using the same loading technique as [ComfyUI-RMBG](https://github.com/1038lab/ComfyUI-RMBG) — bypassing `AutoModelForImageSegmentation.from_pretrained()` entirely to avoid compatibility issues with recent versions of `transformers`.

---

## File structure

```
AE_SAM3_RMBG/
├── jsx/
│   └── SAM3_BG_Remover.jsx     ← The After Effects ScriptUI panel
└── server/
    ├── rmbg_process.py         ← Single image/frame processor (GPU)
    ├── rmbg_sequence.py        ← PNG sequence batch processor (GPU, model loads once)
    ├── rmbg_adjust.py          ← Mask expand/blur (CPU only, ~200ms)
    ├── batch_process.py        ← Optional: run batch jobs from terminal
    ├── start_server_windows.bat
    ├── start_server_mac.sh
    └── test_setup.bat          ← Verify Python + model paths
```

---

## Troubleshooting

**"No layer selected"**  
→ Click on a layer in the timeline before pressing the button.

**"rmbg_process.py not found"**  
→ Make sure the `server/` folder is inside the AE Scripts directory (see Step 1).

**"Model not found"**  
→ Open ComfyUI and run the RMBG node once to download the model automatically.

**Python keeps saying "starting…" for a long time**  
→ The log box shows the Python log file path. Open it directly to see the raw error output.

**GPU not being used / slow processing**  
→ Verify CUDA is working in ComfyUI first. If it works there, it will work here.

**Temp files accumulating**  
→ They are cleaned automatically on panel open. To manually clear: delete `%LOCALAPPDATA%\Temp\rmbg_ae\`

---

## License

The script (JSX + Python) is released under **MIT License** — free to use, modify, and distribute.

The AI models have their own licenses:
- **BiRefNet** (general / HR / HR-matting): [Apache 2.0](https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE)
- **RMBG-2.0**: [BRIA AI license](https://huggingface.co/briaai/RMBG-2.0) — non-commercial use only

---

## Credits

- [ComfyUI-RMBG](https://github.com/1038lab/ComfyUI-RMBG) by 1038lab — model loading approach and inspiration
- [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) by ZhengPeng7
- [RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0) by BRIA AI
