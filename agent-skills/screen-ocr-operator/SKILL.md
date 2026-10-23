---
name: screen-ocr-operator
description: 默认用截图 + 视觉模型（step-5-preview）识别界面并按坐标操作，控件树兜底；核对目标和坐标后执行用户要求的手机操作。
---

# 读屏与截图操作

使用实际应用所提供的 Android 工具与能力状态。通道可以是 Root、Shizuku 或 ADB，不假设身份为 uid=2000，不把guest root当Android Root。

先核对屏幕、方向、目标应用和授权。默认用 mcp__dsha-android__android_screenshot 截图（原生 PNG 直接进模型上下文），交给视觉模型（step-5-preview）识别要操作的元素，再按图中坐标用 mcp__dsha-android__android_click 点按；控件树 mcp__dsha-android__android_get_state 只作兜底——截图识别失败、需要精确文字匹配、或元素没有视觉特征时才用，拿到它的中心坐标后仍按坐标点按。能否截图取决于实际系统、服务和本次授权，不能从Standard/Low名称推导全设备支持。

根据截图识别出的坐标点击、滑动、输入；用控件树兜底时取每项的中心坐标。截图坐标、虚拟屏坐标和主屏必须对应；PiP、键盘、悬浮窗可能遮挡，不能只按旧 XML 坐标。每次操作后重新截图核对，目标不可核验或已改变时停止，不伪报完成。

活动配对或持续无障碍服务期间不使用uiautomator dump，避免抑制其它服务。授权绑定运行代次；停止、断连、重启或手动撤销后重新核对，不继承旧授权。

只读信息走当前受管入口：

```sh
/root/dsh-bin/adb-shell "id"
/root/dsh-bin/adb-shell "getprop ro.product.model"
```

不以裸adb或其它通道重放未知结果。敏感应用和确认窗口采用原生执行点限制，不替用户确认维护写入。

不把截图、密钥、配对码或对话写公开取证目录。临时图只清理本次工具明确创建的文件，不批量删除用户Pictures/Downloads/历史原件。核对结果后报告实际完成情况。

## 精确定位：android_detect_ui（WebView/游戏首选）

当 android_get_state 无可读节点（WebView、小游戏、Canvas 页面），或对截图目测坐标没把握时，调用 mcp__dsha-android__android_detect_ui：它返回同帧截图 + 带序号的可点元素清单（类别 + 中心坐标）。选中目标元素对应的序号，用 mcp__dsha-android__android_click(index=N) 点击其框中心，不要自己输出肉眼估计的像素坐标——视觉模型目测竖坐标常偏差数百像素（实测在 WebView 游戏菜单上偏约 420px），检测框是像素级精确的。选完即点，避免中途切屏导致序号对应的画面已变。控件树有可读节点时，仍优先按文字/控件点击。
