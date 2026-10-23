#!/usr/bin/env python3
"""钉死 ui-detect ONNX 的输入/输出契约：images[1,3,640,640] -> output0[1,300,6]。

end2end(NMS 已 baked) 导出，容器内不需要 ultralytics 或自写 NMS。
"""
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "app/src/main/assets/ui-detect/yolov8n-ui.onnx"


def main():
    if not MODEL.is_file():
        print("FAIL: 缺少模型", MODEL)
        return 1
    sess = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    inp, out = sess.get_inputs()[0], sess.get_outputs()[0]
    assert inp.name == "images", f"输入名应为 images，实际 {inp.name}"
    assert list(inp.shape) == [1, 3, 640, 640], f"输入 shape 应为 [1,3,640,640]，实际 {inp.shape}"
    assert out.name == "output0", f"输出名应为 output0，实际 {out.name}"
    assert list(out.shape) == [1, 300, 6], f"输出 shape 应为 [1,300,6]，实际 {out.shape}"
    # 跑一次前向，确认可推理且每行 6 列
    dummy = np.zeros((1, 3, 640, 640), dtype=np.float32)
    result = sess.run(None, {inp.name: dummy})[0]
    assert result.shape[1:] == (300, 6), f"前向输出 {result.shape}"
    print(f"OK ONNX contract: {inp.name}{inp.shape} -> {out.name}{out.shape}; forward {result.shape}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
