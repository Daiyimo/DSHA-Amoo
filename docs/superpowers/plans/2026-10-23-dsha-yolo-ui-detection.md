# DSHA YOLO UI 检测接入 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 DSHA 增加可靠的 UI 元素定位：容器侧用 YOLOv8n(ONNX) 检出可点元素框，agent 选序号点击，不再输出肉眼像素坐标。

**Architecture:** 容器内(arm64 Ubuntu / Python 3.14)跑 onnxruntime + 导出的 YOLOv8n-onnx；MCP `dsh-computer-use-android` 新增 `android_detect_ui`（截图→检测→返回同帧图+带序号框清单），`android_click` 扩展为可按序号点框中心。推理栈三个 cp314+aarch64 wheel 按现有 `adb-wheels` 资产机制打进容器。不改 Android App 原生代码。

**Tech Stack:** Python 3.14(容器)/onnxruntime/numpy/Pillow；YOLOv8n→ONNX(imgsz640, end2end NMS)；Node(server.cjs MCP 桥)；Gradle 资产打包(prepare-*-assets)。

**Spec:** `docs/superpowers/specs/2026-10-23-dsha-yolo-ui-detection-design.md`

## Global Constraints

- 容器 = aarch64(arm64) Ubuntu、glibc、**Python 3.14**；wheel 必须 cp314 + manylinux aarch64（已实证 onnxruntime 1.24.x / numpy 2.3.x / pillow 11.3.0 有）。
- 模型输入 `images [1,3,640,640]`，输出 `output0 [1,300,6]`（x1,y1,x2,y2,conf,cls，640 letterbox 空间，end2end NMS 已 baked，**容器内不装 ultralytics、不自写 NMS**）。
- 检测器坐标必须从 640 letterbox 空间**反算回原图坐标**（减 pad、除 scale）。
- 可点类别白名单：`TextButton, Icon, EditText, CheckBox, Checkbox, Switch, Spinner, Multi_Tab, Bottom_Navigation, Card, Remember, CheckedTextView`；conf 默认 0.5；重叠框 IoU≥0.5 合并保留高置信。
- **不改 Android App 原生代码**；MCP 改动 additive，`android_click` 既有 `{x,y}` 路径行为不变。
- 容器固定路径：`/root/.dsha/ui-detect/`（`site-packages/`、`ui_detect.py`、`yolov8n-ui.onnx`）。
- 不主动 commit/push，除非用户明确要求。

## Review Focus

- **非 1200×2670 的画面**（不同宽高比/分辨率）：letterbox 反算若错，点击整体偏移。→ Task 2  round-trip 单测覆盖多种尺寸。
- **last-detect 缓存陈旧**：模型用上一次 detect 的序号，画面已变 → 点到错元素。→ Task 4 缓存刷新/越界错误单测。
- **类别非身份**：框给的是 TextButton 不是"人机对战"，模型选错序号 → 点错按钮。→ Task 4 detect 返回**同帧图**供模型视觉匹配（缓解，非测试可完全覆盖，文档提示）。
- **容器缺 python3/onnxruntime**：detect 报错不能让 agent 崩。→ Task 4 缺运行时错误路径回退单测。
- **叠加层污染**（键盘/ PiP / 对话框元素混入清单）：模型点幻影。→ 白名单+阈值缓解；Task 2 用含底部导航的截图验证不误报可点区。

---

### Task 1: 导出 ONNX 模型并钉死输出契约

**Files:**
- Create: `app/src/main/assets/ui-detect/yolov8n-ui.onnx`（由 best.pt 导出）
- Source model: 下载的 `best.pt`（HuggingFace `yasirfaizahmed/android_ui_detection_yolov8`），放入 `app/src/main/assets/ui-detect/best.pt` 作为导出输入（或在构建脚本内下载）
- Test: `tools/test-ui-detect-onnx.py`

**Interfaces:**
- Produces: ONNX 文件，输入名 `images` shape `[1,3,640,640]`；输出名 `output0` shape `[1,300,6]`。

- [ ] **Step 1: 写导出+契约校验脚本**

`tools/export-ui-onnx.py`：
```python
from ultralytics import YOLO
import onnxruntime as ort, numpy as np, sys
src, dst = sys.argv[1], sys.argv[2]
YOLO(src).export(format="onnx", imgsz=640, nms=True, simplify=True, opset=12)
# ultralytics 输出 best.onx 于 cwd；移动/校验
import shutil, os
produced = os.path.join(os.path.dirname(src) or ".", "best.onnx")
shutil.move(produced, dst)
sess = ort.InferenceSession(dst, providers=["CPUExecutionProvider"])
i, o = sess.get_inputs()[0], sess.get_outputs()[0]
assert i.name == "images" and list(i.shape) == [1,3,640,640], (i.name, i.shape)
assert o.name == "output0" and list(o.shape)[1:] == [300,6], (o.name, o.shape)
print("ONNX contract OK:", i.name, i.shape, "->", o.name, o.shape)
```

- [ ] **Step 2: 运行导出**

Run: `python -I tools/export-ui-onnx.py app/src/main/assets/ui-detect/best.pt app/src/main/assets/ui-detect/yolov8n-ui.onnx`
Expected: 打印 `ONNX contract OK: images [1, 3, 640, 640] -> output0 [1, 300, 6]`

- [ ] **Step 3: 契约测试**

`tools/test-ui-detect-onnx.py`：加载 `yolov8n-ui.onnx`，喂随机 `np.zeros((1,3,640,640),np.float32)`，断言输出 shape `[1,300,6]` 且每行 6 列。Run: `python -I tools/test-ui-detect-onnx.py`；Expected: PASS。

---

### Task 2: 容器检测器 `ui_detect.py` + 主机验收

**Files:**
- Create: `app/src/main/assets/ui-detect/ui_detect.py`（打进容器的脚本，纯 onnxruntime/numpy/Pillow）
- Test: `tools/test-ui-detect.py`

**Interfaces:**
- Produces: CLI `python3 ui_detect.py <image> <model> [conf]` → stdout JSON 数组 `[{index,cls,conf,cx,cy,x1,y1,x2,y2}, ...]`（可点类别、上→下编号）。
- 纯函数 `detect(img_path, model_path, conf=0.5) -> list[dict]`、`letterbox(img, 640) -> (canvas, scale, padx, pady)` 供单测。

- [ ] **Step 1: 写失败的 letterbox 反算单测**

`tools/test-ui-detect.py`：
```python
import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("ui_detect", Path("app/src/main/assets/ui-detect/ui_detect.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
from PIL import Image

def test_letterbox_roundtrip_portrait():
    img = Image.new("RGB", (1200, 2670))
    canvas, scale, px, py = m.letterbox(img, 640)
    assert canvas.size == (640, 640)
    assert scale < 0.25 and py == 0 and px > 0          # 高图：竖向填满、横向补边
    # 原图中心应映射到 640 中心附近再反算回来
    cx, cy = 600, 1711
    bx, by = cx*scale + px, cy*scale + py
    assert abs((bx-px)/scale - cx) <= 2 and abs((by-py)/scale - cy) <= 2

def test_letterbox_roundtrip_landscape():
    img = Image.new("RGB", (2670, 1200))
    canvas, scale, px, py = m.letterbox(img, 640)
    assert canvas.size == (640, 640) and px == 0 and py > 0
```

- [ ] **Step 2: 运行看它失败**

Run: `python -I tools/test-ui-detect.py`（或 `pytest tools/test-ui-detect.py -q`）；Expected: FAIL（`ui_detect` 模块不存在）。

- [ ] **Step 3: 写 `ui_detect.py`（已在本机用 shipping 路径验证过）**

`app/src/main/assets/ui-detect/ui_detect.py`：
```python
import sys, json
import numpy as np
from PIL import Image

CLASSES = ['BackgroundImage','Bottom_Navigation','Card','CheckBox','Checkbox',
 'CheckedTextView','Drawer','EditText','Icon','Image','Map','Modal','Multi_Tab',
 'PageIndicator','Remember','Spinner','Switch','Text','TextButton','Toolbar','UpperTaskBar']
CLICKABLE = {'TextButton','Icon','EditText','CheckBox','Checkbox','Switch','Spinner',
 'Multi_Tab','Bottom_Navigation','Card','Remember','CheckedTextView'}
IMGSZ, CONF, IOU = 640, 0.5, 0.5

def letterbox(img, imgsz=IMGSZ):
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
    if inter <= 0: return 0.0
    aa = (a[2]-a[0])*(a[3]-a[1]); bb = (b[2]-b[0])*(b[3]-b[1])
    return inter / (aa + bb - inter)

def detect(img_path, model_path, conf=CONF):
    import onnxruntime as ort
    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    name = sess.get_inputs()[0].name
    img = Image.open(img_path).convert("RGB")
    canvas, scale, px, py = letterbox(img)
    arr = np.asarray(canvas).astype(np.float32).transpose(2, 0, 1)[None] / 255.0
    out = sess.run(None, {name: arr})[0][0]        # (300,6) 640 空间
    dets = []
    for x1, y1, x2, y2, c, cls in out:
        if c < conf: continue
        cn = CLASSES[int(cls)]
        if cn not in CLICKABLE: continue
        dets.append([(x1-px)/scale, (y1-py)/scale, (x2-px)/scale, (y2-py)/scale, float(c), cn])
    dets.sort(key=lambda d: -d[4]); kept = []
    for d in dets:
        if all(_iou(d[:4], k[:4]) < IOU for k in kept): kept.append(d)
    kept.sort(key=lambda d: d[1])                   # 上→下
    return [{"index": i+1, "cls": d[5], "conf": round(d[4],3),
             "cx": round((d[0]+d[2])/2), "cy": round((d[1]+d[3])/2),
             "x1": round(d[0]), "y1": round(d[1]), "x2": round(d[2]), "y2": round(d[3])}
            for i, d in enumerate(kept)]

if __name__ == "__main__":
    img, model = sys.argv[1], sys.argv[2]
    conf = float(sys.argv[3]) if len(sys.argv) > 3 else CONF
    print(json.dumps(detect(img, model, conf)))
```

- [ ] **Step 4: 加验收测试（绑定原始失败）并跑全绿**

在同文件追加（需模型+onnxruntime，主机可跑）：
```python
def test_gomoku_acceptance():
    import os
    onnx = "app/src/main/assets/ui-detect/yolov8n-ui.onnx"
    img = os.environ.get("DSHA_TEST_SHOT")             # 指向五子棋菜单截图
    if not (os.path.exists(onnx) and img and os.path.exists(img)):
        import pytest; pytest.skip("需要 onnx 与测试截图")
    res = m.detect(img, onnx)
    hit = [r for r in res if abs(r["cx"]-600) < 60 and abs(r["cy"]-1711) < 40]
    assert hit, "人机对战按钮(600,1711)未检出"
    assert len(res) >= 6
```
Run: `DSHA_TEST_SHOT=<五子棋菜单.png> python -I tools/test-ui-detect.py`；Expected: PASS（本机已验证 #3 center≈(596,1712)）。

- [ ] **Step 5: Commit**（仅在用户要求时）

---

### Task 3: 打包推理栈为容器资产 `ui-detect.bin`

**Files:**
- Create: `tools/prepare-ui-detect.py`
- Modify: `tools/runtime-tools.lock.json`（加 onnxruntime/numpy/pillow 版本+sha256）
- Modify: `tools/prepare-standard-assets.py`（`ui-detect` 加入 `.tar.gz`→`.bin` 拷贝名单，镜像 `adb-wheels`）
- Modify: 资产部署读取侧（`tools/asset_deployment.py` 及运行时 bootstrap，镜像 `adb-wheels` 解压目标，改为落到 `/root/.dsha/ui-detect/`）——**需读现有 adb-wheels 解压逻辑后对接**

**Interfaces:**
- Produces: `app/src/main/assets/ui-detect.bin`（gzip+tar，内含 `site-packages/`(三 wheel 解包)、`ui_detect.py`、`yolov8n-ui.onnx`），部署期解压到容器 `/root/.dsha/ui-detect/`。

- [ ] **Step 1: 读 adb-wheels 现有打包/解压路径**

Grep `adb-wheels` 在 `tools/prepare-standard-assets.py`、`tools/asset_deployment.py`、`tools/asset-deployment.json` 及运行时 bootstrap，记录：源 `.tar.gz` 从哪来、`.bin` 如何被解压、解压到容器哪个路径。**计划据此对接 ui-detect。**

- [ ] **Step 2: 锁定三个 aarch64 wheel 到 lock**

在 `tools/runtime-tools.lock.json` 增加（版本用 PyPI 已实证存在 cp314+aarch64 的具体版本；url+sha256 下载时填）：
```json
"uiDetect": {
  "onnxruntime": {"version": "1.24.1", "sha256": "<下载后填>",
    "url": "https://files.pythonhosted.org/.../onnxruntime-1.24.1-cp314-cp314-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl"},
  "numpy": {"version": "2.3.2", "sha256": "<下载后填>",
    "url": ".../numpy-2.3.2-cp314-cp314-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl"},
  "pillow": {"version": "11.3.0", "sha256": "<下载后填>",
    "url": ".../pillow-11.3.0-cp314-cp314-manylinux_2_17_aarch64.whl"}
}
```

- [ ] **Step 3: 写 `tools/prepare-ui-detect.py`**

下载三 wheel(校验 sha256)→ 解出各自 purelib 到 `site-packages/`；连同 `ui-detect/ui_detect.py`、`ui-detect/yolov8n-ui.onnx` 打成 `app/src/main/assets/ui-detect.tar.gz`（gzip+tar，路径规范化，禁 `..`/绝对路径，仿 `prepare-ubuntu-tools.py` 的 tar 写法与 `archive()`）。核心：
```python
# 伪代码：解 wheel(zip) 取 *.py/*.so/*.dist-info 到 site-packages/，打包
with zipfile.ZipFile(whl) as z:
    for n in z.namelist():
        if n.endswith((".data/purelib/",)) or ".." in n.split("/"): continue
        # 仅取运行必需：包目录 + dist-info
        ...
# 打 tar.gz：site-packages/**, ui_detect.py, yolov8n-ui.onnx
```
Run: `python -I tools/prepare-ui-detect.py`；Expected: 生成 `ui-detect.tar.gz` 且内含 `site-packages/onnxruntime/`、`ui_detect.py`、`yolov8n-ui.onnx`。

- [ ] **Step 4: 接入 `.bin` 与部署**

`prepare-standard-assets.py` 的拷贝名单加 `ui-detect`（同 `for name in ("glibc-python","adb-wheels")` 那块加 `"ui-detect"`）；`expected` 集合加 `"ui-detect.bin"`。部署读取侧按 Step 1 所学，把 `ui-detect.bin` 解压到 `/root/.dsha/ui-detect/`。

- [ ] **Step 5: 校验资产可解压且结构正确**

`tools/test-ui-detect-asset.py`：解 `ui-detect.bin`，断言含 `site-packages/onnxruntime/__init__.py`、`ui_detect.py`、`yolov8n-ui.onnx`，且无越界路径。Run 通过。

> **设备/构建验证（本机无法跑，标记待办）**：在真机或完整构建流上确认 `ui-detect.bin` 被解压到 `/root/.dsha/ui-detect/`，且容器内 `PYTHONPATH=/root/.dsha/ui-detect/site-packages python3 /root/.dsha/ui-detect/ui_detect.py <img> /root/.dsha/ui-detect/yolov8n-ui.onnx` 能输出 JSON。

---

### Task 4: MCP server 接入 `android_detect_ui` + `android_click(index)`

**Files:**
- Modify: `app/src/main/assets/builtin-plugins/dsh-computer-use-android/lib/server.cjs`
- Test: `tools/test-ui-detect-mcp.mjs`

**Interfaces:**
- Produces: 工具 `android_detect_ui`（返回同帧截图 image block + 带序号清单文本）；`android_click` 新增可选 `index`。
- 内部：每连接 `lastDetect` 缓存（数组），`resolveClick(index) -> {x,y}`，新 detect 即刷新。

- [ ] **Step 1: 写失败的纯逻辑单测**

`tools/test-ui-detect-mcp.mjs`（仿 `test-android-computer-use.mjs`，用假 bridge/假子进程）：
```js
// 验证：detect 后 click(index) 取到该序号框中心；index 越界报错；新 detect 刷新缓存
const boxes = [{index:1,cls:"Icon",cx:60,cy:215},{index:2,cls:"TextButton",cx:594,cy:1549},
               {index:3,cls:"TextButton",cx:596,cy:1712}];
assert.equal(resolveClick(2, boxes).x, 594);
assert.equal(resolveClick(2, boxes).y, 1549);
assert.throws(() => resolveClick(9, boxes), /越界|invalid/i);
// 缓存刷新
cache.set(boxes); cache.set([{index:1,cls:"TextButton",cx:10,cy:10}]);
assert.throws(() => resolveClick(3, cache.get()), /越界|invalid/i); // 旧 #3 已失效
```
Run: `node tools/test-ui-detect-mcp.mjs`；Expected: FAIL（`resolveClick` 未定义）。

- [ ] **Step 2: 在 server.cjs 实现**

新增常量与缓存（顶部）：
```js
const DETECT_DIR = '/root/.dsha/ui-detect';
const DETECT_SCRIPT = DETECT_DIR + '/ui_detect.py';
const DETECT_MODEL = DETECT_DIR + '/yolov8n-ui.onnx';
const DETECT_SITE = DETECT_DIR + '/site-packages';
const lastDetect = new Map();   // connectionKey -> boxes[]
```
新增工具定义（并入 `definitions`）：
```js
['android_detect_ui','【精确定位】检测屏幕可点元素，返回带序号的框清单与同帧截图；用于控件树读不到(WebView/游戏)或坐标没把握时。按返回的序号用 android_click(index=N) 点击。','/app/ui/detect',{conf:{type:'number',minimum:0.1,maximum:0.9}}],
```
实现 detect 处理器（截图→base64→临时文件→python→JSON→缓存→返回 image block + 文本清单）：
```js
function clickIndexResolver(boxes){
  return (index)=>{ const b=boxes.find(x=>x.index===index);
    if(!b) throw new Error('index 越界或已失效，请重新 android_detect_ui');
    return {x:b.cx, y:b.cy}; };
}
// detect: 复用 bridge 取 mcp 截图(base64) → 写 tmp → execFileSync('python3',[DETECT_SCRIPT,tmp,DETECT_MODEL,String(conf)],{env:{...process.env,PYTHONPATH:DETECT_SITE},timeout:20000}) → JSON.parse → lastDetect.set(key,boxes) → 返回 {imageBlock, text:list}
```
`android_click` 分支：参数有 `index` 时，从 `lastDetect` 取该 key 的 boxes，`clickIndexResolver` 得 (x,y) 走既有 `/app/ui/tap`；无 `index` 时维持原 `{x,y}` 逻辑不变。

- [ ] **Step 3: 跑单测通过**

Run: `node tools/test-ui-detect-mcp.mjs`；Expected: PASS。

- [ ] **Step 4: 缺运行时回退单测**

假 `python3` 不存在/脚本非零退出时，`android_detect_ui` 返回明确错误文本（含"回退到 android_get_state / 坐标点击"），不 throw 到 agent。加断言进 `test-ui-detect-mcp.mjs` 并跑绿。

> **真机 e2e（标记待办）**：连真机跑 `android_detect_ui`→`android_click(index=3)` 点在五子棋「人机对战」上，确认进入对战。

---

### Task 5: 更新 agent skill 文档

**Files:**
- Modify: `agent-skills/screen-ocr-operator/SKILL.md`

- [ ] **Step 1: 增补 detect 用法**

在「控件树兜底」段落后增一节（中文，衔接现有措辞）：
```markdown
## 精确定位：android_detect_ui（WebView/游戏首选）

当 android_get_state 无可读节点（WebView、小游戏、Canvas 页面），或对截图目测坐标没把握时，
调用 mcp__dsha-android__android_detect_ui：它返回同帧截图 + 带序号的可点元素清单(类别+中心坐标)。
按清单选中最目标元素对应的序号，用 mcp__dsha-android__android_click(index=N) 点击其框中心，
不要自己输出肉眼估计的像素坐标。选完即点，避免中途切屏导致序号对应的画面已变。
控件树有可读节点时，仍优先按文字/控件点击。
```

- [ ] **Step 2: 校验**

`python -I tools/test-skill-import.mjs`（或现有 skill 校验入口）确认 SKILL.md frontmatter/格式仍合法。

---

### Task 6: 真机/容器集成验证（设备待办）

**Files:** 无代码；验证记录写回本计划或 issue。

- [ ] **Step 1** 构建安装带 `ui-detect.bin` 的包，确认容器 `/root/.dsha/ui-detect/` 解压完整。
- [ ] **Step 2** 容器内手跑 `ui_detect.py` 于五子棋截图，确认输出 #3 命中 (600,1711)。
- [ ] **Step 3** 真机复跑原任务「打开微信→第一个对话最后链接→人机对战」，确认 `android_detect_ui`+`android_click(index)` 能稳定进入对战并落子。
- [ ] **Step 4** 抽样 5–10 张其它 DSHA 真实截图统计检出/误报，记录是否需调阈值/白名单。

---

## Self-Review

**Spec coverage:** §2 目标→Task2/4；§3 可行性→Task1/3(wheel 锁)；§4 资产→Task3；§5 检测器→Task2；§6 MCP→Task4；§7 文档→Task5；§8 回退→Task4 Step4；§9 测试→Task2/3/4；§10 未决→Task6。覆盖完整。

**Placeholder scan:** Task3 Step1 要求"读 adb-wheels 后对接"、Task6 为设备待办——均为明确的探查/验证动作而非空占位；Task3 wheel 的 sha256/url 标注"下载后填"是锁定机制的正常步骤。无 TBD 式空泛。

**Type consistency:** `detect()→list[dict]`(Task2) 与 MCP `boxes`(Task4) 字段一致(index/cls/conf/cx/cy/x1..y2)；`resolveClick(index,boxes)→{x,y}` 与 `android_click(index)`→`/app/ui/tap?x&y` 一致；容器路径常量三任务统一。

**Review Focus 落点:** 非标准宽高比→Task2 round-trip；缓存陈旧→Task4 Step1/2；类别非身份→Task4 同帧图返回 + Task5 文档；缺运行时→Task4 Step4；叠加层→Task2 白名单+阈值 + Task6 抽样。
