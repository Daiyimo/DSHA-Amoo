#!/usr/bin/env python3
"""ui_detect 的单测：letterbox 反算 round-trip + 五子棋验收（绑定原始失败）。

运行: python -I tools/test-ui-detect.py
五子棋验收需模型与截图: DSHA_TEST_SHOT=<五子棋菜单.png> python -I tools/test-ui-detect.py
"""
import importlib.util
import os
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
_UI = ROOT / "app/src/main/assets/ui-detect"
UI_DETECT = _UI / "ui_detect.py"
MODEL = _UI / "yolov8n-ui.onnx"


def load():
    spec = importlib.util.spec_from_file_location("ui_detect", UI_DETECT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_letterbox_portrait(m):
    canvas, scale, px, py = m.letterbox(Image.new("RGB", (1200, 2670)))
    assert canvas.size == (640, 640)
    assert py == 0 and px > 0 and scale < 0.25, (px, py, scale)  # 高图：竖向填满、横向补边
    cx, cy = 600, 1711
    bx, by = cx * scale + px, cy * scale + py
    assert abs((bx - px) / scale - cx) <= 2 and abs((by - py) / scale - cy) <= 2


def test_letterbox_landscape(m):
    canvas, scale, px, py = m.letterbox(Image.new("RGB", (2670, 1200)))
    assert canvas.size == (640, 640) and px == 0 and py > 0, (px, py)


def test_gomoku_acceptance(m):
    shot = os.environ.get("DSHA_TEST_SHOT")
    if not shot or not os.path.exists(shot):
        print("  SKIP gomoku acceptance (set DSHA_TEST_SHOT=<png>)")
        return
    res = m.detect(shot, str(MODEL))
    hit = [r for r in res if abs(r["cx"] - 600) < 60 and abs(r["cy"] - 1711) < 40]
    assert hit, "人机对战按钮(600,1711)未检出"
    assert len(res) >= 6, f"应至少检出 6 个可点元素，实际 {len(res)}"


def main():
    module = load()
    for name, fn in (
        ("letterbox_portrait", test_letterbox_portrait),
        ("letterbox_landscape", test_letterbox_landscape),
        ("gomoku_acceptance", test_gomoku_acceptance),
    ):
        fn(module)
        print("OK", name)
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
