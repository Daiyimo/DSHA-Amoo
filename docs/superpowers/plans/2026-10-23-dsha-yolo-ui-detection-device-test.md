# DSHA YOLO UI 检测 · 设备验证交接

> 实施完成、本机单测全绿。以下是**只能在真机/容器完成**的 ARM/构建/部署项。
> 部署方案：检测器资产经 `managed-runtime-inputs.json` 的 `installs` 装进容器 `/root/.dsha/ui-detect/`，MCP server 首次 detect 时用随包 wheel 离线 `pip install` 自建 site。**不走 co-locate（那不会把 ui-detect 装进容器，已由代码审查证伪）。

## 0. 改动清单（工作树，未提交；分支 feat/yolo-ui-detection）

- 改：`builtin-plugins/dsh-computer-use-android/lib/server.cjs`（`android_detect_ui`、`android_click(index)`、installs 路径 + pip 自举 + clamp + 异步执行 + 陈旧序号失效 + DETECT_* 错误提示）
- 改：`agent-skills/screen-ocr-operator/SKILL.md`、`tools/test-android-computer-use.mjs`（工具数 6→7）
- 改：`app/src/main/assets/managed-runtime-inputs.json`（+10 installs）、`tools/asset-deployment.json`（+10 packagedFiles）、`app/src/main/assets/runtime-descriptor.json`（重生成）、`.gitignore`
- 新增：`app/src/main/assets/ui-detect/{ui_detect.py, wheels/}`、`tools/{export-ui-onnx.py, prepare-ui-detect.py, test-ui-detect*.py, test-ui-detect-mcp.mjs}`、specs/plans 文档
- **生成且已 gitignore（不入提交）**：`ui-detect/yolov8n-ui.onnx`(12MB)、`ui-detect/wheels/*.whl`(8 个, ~40MB)。当前工作树已生成，可直接构建。

## 1. 代码审查结论与处置

- **C1（已修）**：原 co-locate 方案不会把 `ui-detect/` 装进容器（插件只按 installs 逐文件落盘），设备上必 ENOENT。改为 installs 部署 + 运行时 pip 自举；`tools/test-ui-detect-asset.py` 加"installs 覆盖全部运行文件"断言防再漂移。
- **I1–I5（已修）**：陈旧序号（变更屏幕的操作后清空 lastDetect）、错误文案（DETECT_* 给可执行提示）、中心点越界（clamp 到 PNG 实际宽高）、descriptor 未重生成（已 `--write`）、同步阻塞+stderr 丢失（改异步 execFile + 可取消）。
- **M 类（Minor，暂缓）**：BICUBIC/BILINEAR 对齐、验收夹具未提交（见 §5）、onnxruntime 每次新建 Session、临时文件名可预测、许可声明、sympy/mpmath 瘦身。见 ledger/本档 §5。

## 2. 构建

当前工作树已含 wheel+onnx，可直接构建。**若从干净检出构建**，需先再生两个生成物：
```bash
python tools/prepare-ui-detect.py                                   # 下载 8 个 wheel 到 assets/ui-detect/wheels/
python tools/export-ui-onnx.py <best.pt> assets/ui-detect/yolov8n-ui.onnx   # 导出 ONNX
```
（`best.pt` 来自 HuggingFace `yasirfaizahmed/android_ui_detection_yolov8`。二者尚未接入 gradle preBuild 链，见 §5。）

```bash
./gradlew :app:assembleStandardDebug -Pdsha.coexistSuffix=vision
# 安装前把 <applicationId>.vision 加入 StepOS USB 安装白名单：settings put secure usb_install_item_<完整包名> "DSHA:1"
```

**观察点 A**：`installs` 新增 10 项、`packagedFiles` +10；确认构建/部署校验（`verify-asset-deployment`、descriptor 门禁）通过。

## 3. 容器内落盘与 import 冒烟（最关键）

装好后进设备容器：
```sh
ls /root/.dsha/ui-detect/            # 应有 ui_detect.py, yolov8n-ui.onnx, wheels/（8 个）
# 手动预演 server 的首次自举（免 pip：直接解压 wheel 到 site；容器 python 实为 3.12、无 pip）：
PYTHONPATH=/root/.dsha/ui-detect/site python3 /root/.dsha/ui-detect/ui_detect.py \
  <五子棋菜单.png> /root/.dsha/ui-detect/yolov8n-ui.onnx
```

**观察点 B（已验收 ✓，session 9dbdde1f）**：`android_detect_ui` 在真机成功返回 8 个可点元素（人机战神 #3 @ (595,1712)），`click(index=3)` 命中并进入对局——cp312 wheel + 免 pip 解压（按 python 版本过滤）确认生效。容器 python 是 **3.12(glibc)**、无 pip（早前误判 3.14 已修正）。

## 4. 真机复跑原任务

打开微信 → 点第一个对话最后一个链接 → 人机对战。观察：agent 在 WebView 菜单调 `android_detect_ui` 拿到同帧截图+序号清单 → `android_click(index=N)` 点中人机战神进入对战落子。**观察点 C**：首次 detect 的一次性 pip 自举延迟（数十秒，之后有 `site/.ready` marker 走缓存）；序号与画面同帧。

## 5. 已知保留 / 待办

- **【大工程·记录待做】canvas 棋盘落子**：五子棋进入对局后，在 canvas 棋盘上落子失败——`dispatchGesture` 注入点击到不了/不触发 canvas 落子（实测点击中心 (600,1545) 距真实交叉点 (600,1538) 仅 7px 仍一子未落；DOM 菜单按钮却能点）。可行方向：给 `android_click` 加一条 shell `input tap x y`（InputManager 原生注入）分支，对 canvas/游戏往往比无障碍手势有效；需设备 shell 通道 + 重编验证。**本次不做。**
- **detect-first 指引（已写入，待重编生效）**：session eb754014 里 agent 肉眼估「发现」tab 坐标 y=2500/2450，实测 tab 栏在 y=2529..2643，两击落空。已在 `screen-ocr-operator/SKILL.md` + server.cjs `instructions` 明确优先级：控件树空的自绘/WebView UI **直接用 detect_ui 按序号点，不先肉眼估坐标**（目测常偏 100–420px）。需重编+重装才在设备生效。
- **gradle 接入**：`prepare-ui-detect.py`/`export-ui-onnx.py` 尚未进 preBuild 链；干净检出需先手动跑（§2）。
- **验收夹具**：`tools/test-ui-detect.py` 的五子棋 acceptance 需 `DSHA_TEST_SHOT` 指向截图，否则 SKIP；仓库无截图夹具，建议提交一张脱敏图到 `tools/fixtures/` 让该判据常驻守护。
- **Minor（reviewer）**：BILINEAR 对齐、每次新建 InferenceSession（加模块级缓存）、临时文件名用 `randomUUID`+`wx`、8 个第三方包许可声明（THIRD_PARTY_NOTICES/licenses）、sympy/mpmath 若非必需可瘦身、`.data/scripts|headers` 重映射与 SITE 清理。
- **Node 备选**：`onnxruntime-node` 进程内推理已在本机跑通 acceptance（x64），但其 arm64 绑定 ~57MB 超 installs 32MB/文件上限，需走 `.bin`+ProotBootstrap 才能用；当前 Python 路线无需改设备代码，故采用 Python。
