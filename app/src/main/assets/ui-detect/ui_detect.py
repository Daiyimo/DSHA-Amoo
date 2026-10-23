#!/usr/bin/env python3
"""DSHA UI 检测器（容器内运行）：YOLOv8n-onx 检出可点元素，返回带序号框清单。

纯 onnxruntime + numpy + Pillow，不依赖 ultralytics；模型为 end2end(NMS baked) ONNX，
输出 output0[1,300,6]（x1,y1,x2,y2,conf,cls，640 letterbox 空间），此处反算回原图坐标。

用法: python3 ui_detect.py <image> <model.onnx> [conf]
输出: stdout JSON 数组 [{index,cls,conf,cx,cy,x1,y1,x2,y2}, ...]，可点类别、上→下编号。
"""
import json
import sys

import numpy as np
from PIL import Image

# best.pt(YOLOv8n, 21 类) 的类别顺序；与导出模型的 cls 索引一一对应。
CLASSES = [
    "BackgroundImage", "Bottom_Navigation", "Card", "CheckBox", "Checkbox",
    "CheckedTextView", "Drawer", "EditText", "Icon", "Image", "Map", "Modal",
    "Multi_Tab", "PageIndicator", "Remember", "Spinner", "Switch", "Text",
    "TextButton", "Toolbar", "UpperTaskBar",
]
# 可交互类别白名单：滤掉纯展示类，降低agent选错/点到幻影的概率。
CLICKABLE = {
    "TextButton", "Icon", "EditText", "CheckBox", "Checkbox", "Switch", "Spinner",
    "Multi_Tab", "Bottom_Navigation", "Card", "Remember", "CheckedTextView",
}
IMGSZ, CONF, IOU = 640, 0.5, 0.5


def letterbox(img, imgsz=IMGSZ):
    """等比缩放+补边到 imgsz×imgsz，返回 (canvas, scale, padx, pady)。"""
    w, h = img.size
    scale = min(imgsz / w, imgsz / h)
    nw, nh = round(w * scale), round(h * scale)
    px, py = (imgsz - nw) // 2, (imgsz - nh) // 2
    canvas = Image.new("RGB", (imgsz, imgsz), (114, 114, 114))
    canvas.paste(img.resize((nw, nh)), (px, py))
    return canvas, scale, px, py


def _iou(a, b):
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    if inter <= 0:
        return 0.0
    aa = (a[2] - a[0]) * (a[3] - a[1])
    bb = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (aa + bb - inter)


def detect(img_path, model_path, conf=CONF):
    import onnxruntime as ort

    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    name = sess.get_inputs()[0].name
    img = Image.open(img_path).convert("RGB")
    canvas, scale, px, py = letterbox(img)
    arr = np.asarray(canvas).astype(np.float32).transpose(2, 0, 1)[None] / 255.0
    out = sess.run(None, {name: arr})[0][0]  # (300,6) 640 空间
    dets = []
    for x1, y1, x2, y2, c, cls in out:
        if c < conf:
            continue
        cn = CLASSES[int(cls)]
        if cn not in CLICKABLE:
            continue
        # 反算回原图坐标：减 pad、除 scale
        dets.append([(x1 - px) / scale, (y1 - py) / scale,
                     (x2 - px) / scale, (y2 - py) / scale, float(c), cn])
    # 重叠框合并：保留高置信（end2end NMS 已做大部分，这里兜底跨类重叠）
    dets.sort(key=lambda d: -d[4])
    kept = []
    for d in dets:
        if all(_iou(d[:4], k[:4]) < IOU for k in kept):
            kept.append(d)
    kept.sort(key=lambda d: d[1])  # 上→下
    return [
        {
            "index": i + 1, "cls": d[5], "conf": round(d[4], 3),
            "cx": round((d[0] + d[2]) / 2), "cy": round((d[1] + d[3]) / 2),
            "x1": round(d[0]), "y1": round(d[1]), "x2": round(d[2]), "y2": round(d[3]),
        }
        for i, d in enumerate(kept)
    ]


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("用法: ui_detect.py <image> <model.onnx> [conf]")
        sys.exit(2)
    conf = float(sys.argv[3]) if len(sys.argv) > 3 else CONF
    print(json.dumps(detect(sys.argv[1], sys.argv[2], conf)))
