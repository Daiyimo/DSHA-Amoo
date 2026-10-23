---
name: screen-ocr-operator
description: 定位优先级：控件树(android_get_state) → 自绘/WebView 用 android_detect_ui 按序号点击 → 最后才肉眼估坐标；核对目标和坐标后执行用户要求的手机操作。
---

# 读屏与截图操作

使用实际应用所提供的 Android 工具与能力状态。通道可以是 Root、Shizuku 或 ADB，不假设身份为 uid=2000，不把guest root当Android Root。

先核对屏幕、方向、目标应用和授权。定位按以下优先级，**不要跳级**：
1. 先用 mcp__dsha-android__android_get_state 读控件树——有可读节点时，按文字/中心坐标用 mcp__dsha-android__android_click 点（最稳）。
2. 控件树返回「没有可读节点」时（微信等自绘 UI、WebView、小游戏——这些恒为空），**不要凭截图肉眼估坐标**，直接用 mcp__dsha-android__android_detect_ui 拿带序号的可点元素，再 mcp__dsha-android__android_click(index=N) 点框中心。
3. 只有 detect 也没有可点元素、或目标本是纯背景/非控件区域（如 canvas 游戏盘）时，才退回用 mcp__dsha-android__android_click(rel=[x,y])——**0-1000 归一化坐标**（左上角原点，x 右 y 下，各 0-1000，桥接按屏幕尺寸转换），不要直接给真实像素 x,y。
视觉模型凭截图目测坐标不可靠——实测竖坐标常偏 100–420px（五子棋游戏菜单偏约 420px、微信底部 tab 偏约 130px），检测框才是像素级精确的。能否截图取决于实际系统、服务和本次授权，不能从 Standard/Low 名称推导全设备支持。

**动作后验（重要）**：每次点击/输入/滑动后，下一张截图可能带 `[后验]` 提示——若提示"屏幕无变化（screenshot_exactly_same）"，说明上一步大概率点空/未生效。此时**必须**重新 detect 定位或更换目标/坐标，**切勿重复同一个坐标**；这是对抗"点偏了还反复点同一处"的关键信号。

根据截图识别出的坐标点击、滑动、输入；用控件树兜底时取每项的中心坐标。截图坐标、虚拟屏坐标和主屏必须对应；PiP、键盘、悬浮窗可能遮挡，不能只按旧 XML 坐标。每次操作后重新截图核对，目标不可核验或已改变时停止，不伪报完成。

活动配对或持续无障碍服务期间不使用uiautomator dump，避免抑制其它服务。授权绑定运行代次；停止、断连、重启或手动撤销后重新核对，不继承旧授权。

只读信息走当前受管入口：

```sh
/root/dsh-bin/adb-shell "id"
/root/dsh-bin/adb-shell "getprop ro.product.model"
```

不以裸adb或其它通道重放未知结果。敏感应用和确认窗口采用原生执行点限制，不替用户确认维护写入。

不把截图、密钥、配对码或对话写公开取证目录。临时图只清理本次工具明确创建的文件，不批量删除用户Pictures/Downloads/历史原件。核对结果后报告实际完成情况。

## 精确定位：android_detect_ui（自绘/WebView 界面的首选定位）

对控件树恒为空的自绘 UI（如微信）、WebView、小游戏，这是首选定位手段（见上文优先级 2）：调 mcp__dsha-android__android_detect_ui 返回同帧截图 + 带序号可点元素（类别 + 中心坐标），按目标选序号用 mcp__dsha-android__android_click(index=N) 点其框中心。选完即点，避免中途切屏致序号失效（画面变更后旧序号会报 DETECT_STALE，需重新 detect）。局限：它检测的是 UI 元素（按钮/输入框/图标），**不识别游戏棋盘格线等 canvas 内部交叉点**——那类目标仍需别的手段。
