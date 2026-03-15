#!/bin/bash
# ============================================================
#  SAM3 Background Removal Server – macOS / Linux Launcher
#  Run this BEFORE opening After Effects
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Auto-detect ComfyUI path
detect_comfyui() {
    local candidates=(
        "$HOME/ComfyUI"
        "$HOME/comfyui"
        "/opt/ComfyUI"
        "/Applications/ComfyUI"
    )
    for p in "${candidates[@]}"; do
        if [ -d "$p" ]; then
            echo "$p"
            return
        fi
    done
    echo ""
}

COMFYUI_PATH="${1:-$(detect_comfyui)}"

if [ -z "$COMFYUI_PATH" ] || [ ! -d "$COMFYUI_PATH" ]; then
    echo "ComfyUI not found in default locations."
    read -p "Enter your ComfyUI path: " COMFYUI_PATH
fi

echo ""
echo "============================================================"
echo "  SAM3 Background Removal Server"
echo "  ComfyUI: $COMFYUI_PATH"
echo "  Port:    9876"
echo "============================================================"
echo ""

# Use ComfyUI's venv if available
if [ -f "$COMFYUI_PATH/venv/bin/python" ]; then
    PYTHON="$COMFYUI_PATH/venv/bin/python"
elif [ -f "$COMFYUI_PATH/.venv/bin/python" ]; then
    PYTHON="$COMFYUI_PATH/.venv/bin/python"
else
    PYTHON="python3"
fi

echo "Python: $PYTHON"
echo ""

"$PYTHON" "$SCRIPT_DIR/sam3_server.py" --comfyui "$COMFYUI_PATH" --port 9876
