# DSHA YOLO UI 检测接入 · 设计文档

- 日期：2026-10-23
- 状态：已与用户确认设计（方案 A：检测工具 + 按序号点击），待 spec 复审后进入实现计划
- 影响范围：DSHA-Amoo 容器侧运行时 + MCP `dsh-computer-use-android` + agent skill 文档；**不改 Android App 原生代码**

## 1. 背景与根因（真机 log 取证 + 模型验证 spike）

### 1.1 失败根因（session-405b4b13 真机 log）

用户任务「打开微信 → 点第一个对话最后一个链接 → 人机对战先落子完成比赛」，turn 1 执行 19 步后被用户 abort。失败点：

- 链接打开的是微信内 **WebView 渲染的五子棋游戏菜单**。agent 三次点击「人机对战」按钮（y=1250/1290/1300）屏幕毫无变化（点击前后截图像素级一致，仅状态栏时钟变）。
- **根因是视觉模型纵向坐标估偏约 420px**：实测「人机对战」按钮中心在 **(600,1710)**，agent 估成 ≈1290，点到了按钮上方的装饰插图空白区。x=600 每次准确（正是按钮水平中心）→ 排除缩放/坐标错位，是纯视觉定位失误。
- **放大成不可恢复失败的原因**：`android_get_state`（控件树兜底）对该 WebView 返回「没有可读节点」——微信 WebView 不暴露无障碍节点。此时 DSHA 只剩「截图 + 肉眼估坐标」一条路，估偏即无路可退。
- 点击机制本身无恙：`uiTap`→`dispatchGesture` 的手势被系统接受且 completed；同会话原生点击（进会话、点链接）都成功。

### 1.2 模型验证 spike（2026-10-23，已跑通）

用 HuggingFace `yasirfaizahmed/android_ui_detection_yolov8`（YOLOv8 **Nano**，21 类，PyTorch `best.pt` ≈6MB，apache-2.0）对**同一张失败截图**跑推理（torch 2.6 CPU，imgsz=640）：

- 6 个菜单按钮全部检出，框中心命中真实位置到 **1–2px**；「人机对战」TextButton conf=0.96 box=(152,1644,1046,1778) **center=(599,1711)**。误检仅底部导航栏一条低分（conf≈0.56，阈值 ≥0.7 可滤）。
- 微信原生界面（会话输入框 EditText conf=0.95、列表项/头像/底部 tab）亦正常定位。
- **结论**：该模型解决「定位」这一半问题——决定性地。在最抓瞎的 WebView 游戏画面上给出像素级精确框。

### 1.3 关键边界

模型给的是**类别**（TextButton…）不是**身份**（哪个是「人机对战」）。因此不是「检测到就点」，而是 **YOLO 出精确框、视觉模型只选序号**——各司其职：YOLO 擅长坐标不识字，VLM 会读字但估坐标灾难性差。让 VLM 从此**不再输出肉眼像素**，直接治本。

## 2. 目标与非目标

**目标**

1. 给 DSHA 的按坐标点击增加一条可靠的定位来源：新增 `android_detect_ui` 返回带序号的可点元素框；`android_click` 扩展为可按序号点击框中心。
2. 覆盖控件树为空（WebView/游戏）或视觉没把握的场景，与现有 `android_get_state` 并存（有节点时仍优先控件树）。
3. 容器侧实现，**不改 Android App 原生代码**。

**非目标（YAGNI）**

- 不做每次截图都跑的常驻检测，不在图上画编号叠加标记（Set-of-Marks 重型版，A 稳定后再评估）。
- 不改 Android App、不改 `dispatchGesture`/控件树/dump 既有行为。
- 除 onnxruntime/numpy/pillow 三个 wheel 外不引新依赖；不加缓存/框架/状态机。
- 不训练/微调模型，直接用现成 `best.pt` 导出的 ONNX。

## 3. 可行性结论（容器侧，已取证）

- 容器 = **aarch64(arm64) Ubuntu、glibc、Python 3.14**（`prepare-standard-assets.py` 处理 `usr/bin/python3.14`；运行时含 `@deepseek-ai/dsh-experimental-ptc-runtime-python`，harness 本身在容器内跑 Python）。
- 现有「把 Python wheel 打进容器」机制：`adb-wheels.tar.gz`→`.bin`（`prepare-standard-assets.py:131`）、`glibc-python.bin`、`ubuntu-tools.bin`（`prepare-ubuntu-tools.py` 锁定下载配方）。
- **推理栈 cp314+aarch64 wheel 齐全**（PyPI 实证）：onnxruntime `1.24.x-cp314-manylinux_2_27_aarch64`、numpy `2.3.x-cp314-manylinux_2_27_aarch64`、pillow `11.3.0-cp314-manylinux_aarch64`。**无需源码编译。**

## 4. 改动 A：构建期资产（容器侧，新增）

仿 `adb-wheels`/`prepare-ubuntu-tools.py` 配方，新增一个资产把推理栈与检测器送进容器：

| 项 | 内容 |
|---|---|
| 模型 | `best.pt` 导出为 ONNX（YOLOv8n，imgsz=640），随包 `yolov8n-ui.onnx` |
| 脚本 | `ui_detect.py`（纯 Python：PIL 解码 → letterbox → onnxruntime → NMS/阈值 → 反算原图框 → 输出 JSON） |
| 依赖 | onnxruntime + numpy + pillow 的 cp314+aarch64 wheel，**版本+sha256 锁定**（进 `runtime-tools.lock.json`，同 pnpm/certifi 先例） |
| 打包 | 生成为 `.bin`(gzip+tar) 资产，部署期解压到容器固定目录 `/root/.dsha/ui-detect/`（含 `site-packages/`、模型、脚本） |

打包脚本与 `asset-deployment`/`prepare-standard-assets.py` 的接入点在实现计划中定稿（镜像 `adb-wheels` 的 `.tar.gz`→`.bin` 路径）。

## 5. 改动 B：容器内检测器 `ui_detect.py`

- **入参**：图片路径 + 可选 conf（默认 0.5）。**输出**：JSON 数组 `[{index, cls, conf, x1,y1,x2,y2, cx,cy}]`，仅可点类别，按阅读序（上→下）编号。
- **坐标 letterbox 反算（正确性核心）**：原图 1200×2670 → 640×640，`scale=min(640/W,640/H)`，补边居中；输出框减 pad、除 scale 回原图坐标。单测用五子棋真值锚定。
- **可点类别白名单**：`TextButton, Icon, EditText, CheckBox, Checkbox, Switch, Spinner, Multi_Tab, Bottom_Navigation, Card, Remember, CheckedTextView`。滤除 `BackgroundImage, Image, Map, Text, UpperTaskBar, PageIndicator, Drawer, Modal` 等纯展示类。
- **阈值与去重**：conf ≥ 0.5（实测真按钮 0.91–0.98、误检 0.27–0.61，分层干净）；YOLO 内置 NMS(IoU 0.45) 后，对 IoU ≥ 0.5 的重叠框合并、保留高置信/可交互类（排行榜那条 TextButton+EditText 重叠并成一个）。

## 6. 改动 C：MCP server（`app/src/main/assets/builtin-plugins/dsh-computer-use-android/lib/server.cjs`）

- **新增工具 `android_detect_ui`**（无可选参或可选 conf）：调桥接 `/app/ui/screenshot` 取 fresh PNG → 写临时文件 → 壳调 `python3 /root/.dsha/ui-detect/ui_detect.py <img> [conf]`（`PYTHONPATH=/root/.dsha/ui-detect/site-packages`）→ 解析 JSON。**返回同帧截图 image block + 带序号可点清单文本**（图和框严格同帧，模型选不错位）。
- **扩展 `android_click`**：新增可选 `index` 参数。server 用「上次 detect 结果」的内存缓存（每连接一份，新 detect 即刷新）按序号取框中心 (cx,cy)，调 `/app/ui/tap?x&y`。既有 `{x,y}` 路径完全不变（向后兼容）。
- 其余工具、桥接路由、`HttpShellService`、`DshaAccessibilityService` 不动。

## 7. 改动 D：agent 文档

`agent-skills/screen-ocr-operator/SKILL.md` 增一节：当 `android_get_state` 无可读节点（WebView/游戏）或对坐标没把握时，先 `android_detect_ui` 再按序号 `android_click(index=…)`；控件树有节点时仍优先控件树。措辞与现有「截图估坐标、控件树兜底」衔接，不推翻原流程。

## 8. 错误处理与回退

| 情况 | 行为 |
|---|---|
| 容器无 python3/onnxruntime、脚本报错 | `android_detect_ui` 返回明确错误文本；模型回退现有行为（截图估坐标 / 控件树） |
| 检测零结果 | 返回空清单 + 说明；模型回退 |
| detect 与 click 之间画面变化 | 点击可能落空；约定 detect→click 紧邻执行，文档提示「选完即点、不要中途切屏」 |
| index 越界/缓存为空 | `android_click(index=…)` 返回明确错误，提示先 detect |

改动全部 additive：onnxruntime 缺失或模型不适用的最坏情况 = 新工具不被使用，现有能力零回归。

## 9. 测试与验收（绑定原始失败）

1. **验收主测**：对已存五子棋菜单截图跑 `ui_detect.py`，断言「人机对战」框中心落在 **(600,1710)±8px**、且稳定给出 ≥6 个可点按钮——即当初失败画面转为可点。
2. **坐标反算单测**：letterbox 映射在多种原图尺寸下往返误差 ≤ 数 px。
3. **原生界面合理性**：微信会话/列表检出输入框、列表项、tab 等可点元素。
4. **MCP handler 端到端**：仿 `tools/test-android-computer-use.mjs`，`android_detect_ui`→`android_click(index)` 全链路（含临时文件、python 调用、JSON 解析、缓存取中心）。
5. **回退路径**：模拟 onnxruntime 缺失/零结果，验证返回明确错误且不影响既有 x/y 点击。

## 10. 风险与未决（实现计划中定稿）

- 容器内 `python3` 的确切路径（→3.14）与 `PYTHONPATH` 布局：实现时探明并写入脚本调用（小）。
- 每次 detect 延迟 = fresh 截图 + YOLO(设备 CPU ~100–300ms)；按需调用可接受。
- 模型在测试集外的泛化未充分验证；因改动 additive，最坏情况是新工具置信度低不被采用，不破坏现状。可选：实现后补一批 DSHA 真实截图抽样统计。
