#!/usr/bin/env python3
"""把 YOLOv8 的 best.pt 导出为 end2end(NMS baked) ONNX，imgsz=640。

用法: python -I tools/export-ui-onnx.py <best.pt> <out.onnx>
源模型: HuggingFace yasirfaizahmed/android_ui_detection_yolov8 的 best.pt。
导出后即符合 test-ui-detect-onnx.py 契约：images[1,3,640,640] -> output0[1,300,6]。
"""
import shutil
import sys
from pathlib import Path


def main():
    if len(sys.argv) != 3:
        print("用法: export-ui-onnx.py <best.pt> <out.onnx>")
        return 2
    src, dst = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    if not src.is_file():
        print("FAIL: 源模型不存在", src)
        return 1
    from ultralytics import YOLO

    produced = YOLO(str(src)).export(format="onnx", imgsz=640, nms=True, simplify=True, opset=12)
    produced = Path(produced).resolve()
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(produced), str(dst))
    print("exported:", dst, dst.stat().st_size, "bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
