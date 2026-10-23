#!/usr/bin/env python3
"""校验 ui-detect 资产布局 + installs 覆盖（防 C1：资产进 APK 却没装进容器）。

运行: python -I tools/test-ui-detect-asset.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UI = ROOT / "app/src/main/assets/ui-detect"
WHEELS = UI / "wheels"
INSTALLS = ROOT / "app/src/main/assets/managed-runtime-inputs.json"
NEED = {"onnxruntime", "numpy", "pillow", "flatbuffers", "packaging", "protobuf", "sympy", "mpmath"}


def main():
    for req in ("ui_detect.py", "yolov8n-ui.onnx"):
        if not (UI / req).is_file():
            print("FAIL 缺少", req)
            return 1
    if not WHEELS.is_dir():
        print("FAIL 缺少 wheels/，请先运行 tools/prepare-ui-detect.py")
        return 1
    wheels = sorted(p.name for p in WHEELS.glob("*.whl"))
    have = {w.split("-")[0].lower() for w in wheels}
    missing = NEED - have
    if missing:
        print("FAIL wheels 缺少包：", sorted(missing))
        return 1
    # C1 守卫：每个运行必需文件都必须登记在 installs，否则进得了 APK、进不了容器。
    installs = json.loads(INSTALLS.read_text(encoding="utf-8"))["installs"]
    listed = {e["asset"] for e in installs}
    must = ["ui-detect/ui_detect.py", "ui-detect/yolov8n-ui.onnx"] + ["ui-detect/wheels/" + w for w in wheels]
    not_listed = [m for m in must if m not in listed]
    if not_listed:
        print("FAIL 以下 ui-detect 文件未在 managed-runtime-inputs.json 的 installs 登记（不会装进容器）:")
        for m in not_listed:
            print("   ", m)
        return 1
    print("OK ui-detect 资产布局 + installs 覆盖：%d 个运行文件已登记" % len(must))
    return 0


if __name__ == "__main__":
    sys.exit(main())
