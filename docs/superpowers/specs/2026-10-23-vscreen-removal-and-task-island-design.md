# 移除虚拟屏子系统 + 执行状态灵动岛 · 设计文档

- 日期：2026-10-23
- 状态：已与用户确认设计，待 spec 复审后进入实现计划
- 影响范围：DSHA-Amoo（`com.dsh.client.vision` 共存测试包 / 上游 `com.dsh.client`）

## 1. 背景与根因（真机取证，2026-10-23）

用户反馈「执行时把对话搬到虚拟屏」会导致系统重启。抓取真机全缓冲 logcat + dropbox + 重启现场后定位：

- **直接根因**：Activity 落到虚拟屏后，WindowManager Transition 的 BLAST 同步组永不完成，约 10 秒后 `onTimeout → finishNow → calculateTransitionRoots` 对 null WindowContainer 调用 `makeAnimationLeash()`：

```
FATAL EXCEPTION IN SYSTEM PROCESS: android.display
java.lang.NullPointerException: 'SurfaceControl$Builder WindowContainer.makeAnimationLeash()' on null
  at Transition.calculateTransitionRoots(Transition.java:3328)
  at Transition.onTransactionReady(Transition.java:2175)
  at BLASTSyncEngine$SyncGroup.onTimeout → finishNow
```

- system_server 死亡 → zygote 退出 → framework 重启。**内核未重启**（uptime 17h27m 不变），用户观感即「系统重启」。
- **复现率 5/5**：09:15 / 09:30 / 09:34 / 09:36 / 10:09 五次 `system_server_crash` 堆栈逐字一致，每次都在 DSHA-VirtualScreen 创建后约 10 秒；昨天 20:47 还有一次。
- **关键对照**：scrcpy 的镜像虚拟屏当天创建 3 次零崩溃——雷区精确为「**往虚拟屏上启动/搬迁 Activity**」，不是「创建虚拟屏」本身。
- **不可修**：崩溃在 system_server 的 Transition 代码里（ROM 框架 bug），DSHA 作为普通应用无法规避（延迟/重试均无效，崩在同步超时路径上）。
- 取证产物：`E:\tmp\dsha-reboot-debug\`（`logcat-all.txt`、`post-reboot.txt`、`watcher.log`）。

**结论**：本设备上任何「把 Activity 放上虚拟屏」的路径都必须移除，包括执行期对话搬迁（本分支新增）与上游 vscreen 远程控制流（agent 经 MCP 工具把应用启动进虚拟屏，同一崩溃类）。

## 2. 目标与非目标

**目标**

1. 整体移除 vscreen 子系统（App 侧 + agent 侧工具 + 桥路由 + shell 通道策略 + 资产/测试），虚拟屏相关崩溃触发面归零。
2. agent 任务执行期间，DSHA 不再自动进入画中画。
3. 执行状态以自绘悬浮胶囊（灵动岛）展示：任务阶段 + 计时，点击回对话，长按请求停止。

**非目标**

- 不保留任何虚拟屏能力（含纯镜像预览）。
- 不改画中画在非执行场景的行为（上游 PiP 功能与回归测试不动）。
- 不接入系统 promoted 胶囊（第 3 节已证不可达）。
- 不改通知栏任务通知（保持权威渠道与现有全部行为）。

## 3. 系统胶囊可行性结论（spike，2026-10-23）

用户要求优先尝试系统胶囊（StepOS 灵动岛）。实测证据：

1. 胶囊 = Flyme 血统的 LiveNotification/Island 特性，**包白名单制**：`Settings.System` 的 `stepos_app_support_livenotification_pkgs = com.android.alarmclock,com.stepos.ailauncher,android,com.stepos.aiengine,com.stepos.safe`，仅系统包。
2. 实测：以白名单内的 shell 包（`android`）经 `cmd notification post --ongoing` 发持续通知，资格管线 `LiveNotificationCapsuleRefresh: eligible=0 main=null`，不出现胶囊。
3. 1.5 小时真实日志中胶囊从未有过内容（用户 10:00 点灵动岛区域，`isShowing=false`）。
4. 与 AGENTS.md 既有决定「任务通知采用标准进度通知，不请求系统 promoted 胶囊」一致。

**结论：系统胶囊对第三方 App 不可达，灵动岛走自绘悬浮胶囊。** 测试后已恢复设备原状（白名单未改动、测试通知已清除）。

## 4. 改动 A：vscreen 子系统整体移除

### 4.1 删除清单（文件级）

**主源码（`app/src/main/java/com/deepseekharness/app/`）**

| 目标 | 处置 |
|---|---|
| `vscreen/` 整目录（12 文件：Core/Manager/Channels/Channel/Accessibility/Activity/Foreground/OverlayController/PreviewView/Previews/Input） | 整删 |
| `util/VirtualScreenPolicy/Stroke/InputPolicy/InputResult/Routes/RequestFence/Errors/Failures/Bootstrap/VscreenBridgeRequest`（10 个纯 vscreen 类） | 整删 |
| `HttpShellService`：`/app/vscreen/*` 路由注册、`deviceVscreenStart/Commit`、`appVscreen` handler、`appHelp()` 中「独立虚拟屏」整段 | 删代码段 |
| `util/BridgeRoutes`：`DEVICE_VSCREEN_START/COMMIT`、`VSCREEN` 枚举与 2 条路由 | 删 5 行 |
| `util/DeviceShellPolicy`：`Kind.VIRTUAL_SCREEN` + `inspectVirtualScreenLaunch` | 删 |
| `RootShell`、`RootShellMain`、`ShellService`、`DeviceShellExecutor`、`ShizukuShell`、`bridge/AdbBridge` 的 `execVirtualScreen/executeVirtualScreen` 六处入口 | 删 |
| `DshaApp`：`virtualScreenOwner` 字段与 `virtualScreenManager()` | 删 |
| `DshaAccessibilityService`：`virtualControl/virtualRoot/virtualDump/virtualInput` 4 方法 | 删 |
| `ForegroundActivity`：resume/pause 两处 vscreen 调用 | 删 |
| `core/WebLifecycleController`：`stopWeb/enqueueStop` 两处 `VirtualScreenManager.stop()` | 删 |
| `ui/DeviceGrantsFragment`：「打开虚拟屏」按钮/提示、`config_execution_vdisplay` 开关逻辑、3 处 `revoke()` | 删 |
| `ui/PictureInPictureActivity`：`moveConversationToVirtualDisplay/applyVirtualDisplay/restoreConversationFromVirtualDisplay/scheduleVirtualMove` 及字段常量（`263c31b` 全部引入物） | 删 |
| `core/ConfigStore` + `util/Constants`：`KEY_EXECUTION_ON_VIRTUAL_DISPLAY` | 删 |
| `util/BuiltinPluginRegistry`：去掉 `dsh-tool-vscreen` | 重新生成 |
| `AndroidManifest.xml`：`.vscreen.VirtualScreenActivity` 声明 | 删 |

**测试（`app/src/test/`）**：`vscreen/` 下 4 个 + `util/` 下 12 个（`VirtualScreen*Test`、`VscreenBridgeRequestTest`）整删；`DeviceShellPolicyTest`（5 处 `inspectVirtualScreenLaunch` 用例）、`BridgeRoutesTest`（`/app/vscreen/status` 及 3 个非法变体）、`OneShotLaunchAuthorityTest`（命令行 fixture 去掉 VirtualScreenCore）、`BridgeConfirmationsTest`（注释）改断言。

**资产（`app/src/main/assets/`）**：`builtin-plugins/dsh-tool-vscreen/` 整目录、`builtin-plugins.json` 条目、`dsha-builtin.txt` 行、`managed-runtime-inputs.json` 4 条映射、`adb-shell.py` 的 `vscreen_*` 函数与 `VIRTUAL_SCREEN` 分支、`device-shell-policy.py` 的 `VIRTUAL_SCREEN` kind 与校验、`register-builtin-plugins.py` 的 `vscreen_workaround_text/migrate_vscreen_workaround`（只服务该插件的重复 insert 迁移，随插件一并退场）。

**tools/**：`fixtures/vscreen-manager/`（`ManagerHttpFixture.java` 声明 vscreen 包，包消失后无法编译）、`test-adb-vscreen-bridge.py`、`test-vscreen.mjs`、`test-vscreen-bundle.mjs`、`test-vscreen-manager-http.py`、`vscreen-test-dependencies.json` 整删；`host-tests.manifest.json`（4 条）、`test-bridge-files.py`、`test-bridge-routes.py`、`test-bridge-token-transport.py`、`test-core-boundaries.py`、`java-format-files.json`、`smoke-dsh-runtime.mjs` 逐条删；`i18n/messages.json` 的 `/app/help` 中英文「独立虚拟屏」整段（漏改会导致 i18n 一致性检查失败）。

**文档**：`docs/virtual-screen-guide.md` 整删；历史 release/audit 文档留档不动（发布追溯）；`docs/security-model.md:28` 一句话改写；AGENTS.md 追加本轮决定（见第 9 节）。

### 4.2 保留清单（实现时不得误删）

- `util/VirtualScreenWindowPolicy`：**主屏无障碍 dump 共用**（`DshaAccessibilityService:300-313`），仅删 vscreen 调用方，保留类与测试。
- `util/ScreenActionResult`：主屏 `/app/ui/*` 共用契约。
- `SYSTEM_ALERT_WINDOW` 权限：流式悬浮条与灵动岛共用。
- 上游画中画其他行为、全部既有 PiP 回归测试。
- `dsh-task-notifier` / `dsh-status-overlay` 等其余内置插件。

### 4.3 生成物与校验刷新

1. `python tools/prepare-runtime-descriptor.py --write`（launcher 源码与资产 SHA 变化后必须重跑）。
2. `BuiltinPluginRegistry.java` 由 `builtin-plugins.json` 重新生成（`tools/generate-builtin-plugins.py`）。
3. 同步 `managed-runtime-inputs.json`、`dsha-builtin.txt`。
4. 若构建报「dsh 离线运行时与当前补丁/依赖锁不一致」：`cwd=tools` 重跑 `builder.recipe_inputs()`，只改写 `dsh-runtime.inputs.json` 的 `inputs` 字段，保留 `archive_sha256`。

### 4.4 执行顺序（每步保持可编译）

1. tools/ 与测试（先断编译耦合）
2. 资产与生成物（插件、清单、i18n）
3. `vscreen/` 包 + util 纯 vscreen 类
4. shell 通道六入口（`Kind.VIRTUAL_SCREEN` 最后删）
5. 桥（`HttpShellService`/`BridgeRoutes`）与其余集成点
6. Manifest 与 descriptor 重生成
7. 构建 + 单测

### 4.5 风险

- descriptor SHA / i18n 漏改 → 构建或检查显性失败，可即时发现。
- 已迁移安装的 `cordis.patch.yml` 残留：本机单用户场景直接删除迁移函数，不做回退兼容。
- 运行时若仍缓存旧插件：装新 APK 会触发完整 `installManagedAssets`，以 `run-as` 核对 rootfs 无 `dsha-tool-vscreen` 为准。

## 5. 改动 B：执行期间抑制画中画

- **判定点**：`util/PictureInPicturePolicy.canEnter()` 增加 `taskActive` 参数（纯逻辑，配单测），auto-enter 与 `enterIfAllowed()` 手动进入两条路径同时覆盖。
- **状态源**：`AgentTaskNotifications` 新增 `hasActiveTask()`（基于 `snapshot()` 判断任一 row active）。
- **刷新机制**：`AgentTaskNotifications` 增加极简 StateListener（桥事件到达 + 现有 1Hz tick 时通知）；`PictureInPictureActivity` 在 resume 注册 / pause 反注册，收到通知走既有 `refreshPictureInPicture()` 重算 `autoEnter`。
- **竞态接受**：task-notifier 的 `running` 事件先于 agent 启动应用到达；若极端情况下 DSHA 已被盖住，最坏退化为一次画中画（与现状一致），任务结束的 `restoreConversation()` 行为不变。
- **无任务时**行为与现状逐字节一致。

## 6. 改动 C：灵动岛（自绘悬浮胶囊）

### 6.1 组件划分

- `util/AgentTaskIslandState`（纯逻辑，无 Android 依赖，必须配单测）：输入 `(task rows, DSHA 是否前台, now, 开关, 权限)` → `IslandView{ visible, text, generation, instance, session, terminal }`。覆盖：可见性全部分支、多任务取最近活跃、终态停留、计时文本。
- `AgentTaskIsland`（`com.deepseekharness.app` 根包，仿 `OverlayController` 的静态控制器）：epoch 防串、主线程、teardown、权限门、configuration 监听，全部沿用其已验证结构。

### 6.2 窗口与交互

- `TYPE_APPLICATION_OVERLAY`，`FLAG_NOT_FOCUSABLE | FLAG_NOT_TOUCH_MODAL`，顶部居中，`y≈6dp`，宽高 WRAP_CONTENT，深色半透明圆角、单行。
- 文案：`AgentTaskNotifications.phase(row)`（中英文现成）+ 秒级计时，形如「DSHA · 正在执行工具 · 0:12」。
- **点击 = 回对话**（`BrowserConversationRoute.conversation(...)`，与通知栏「回聊天」同路径）；**长按 = 请求停止**（与通知栏「停止」同路径，不新造机制）。
- 终态（完成/已停止）显示 3 秒后淡出；DSHA 回前台立即隐藏。

### 6.3 数据源与生命周期

- 复用 `AgentTaskNotifications` 现有 1Hz tick 调 `AgentTaskIsland.refresh(ctx)`（不新建线程/定时器），`phase=ended` 的即时 render 路径同步调一次。
- 可见条件：有活跃任务 && `ForegroundActivity.current() == null` && 开关开（默认开）&& `Settings.canDrawOverlays`。
- 与流式悬浮条（`OverlayController`）相互独立、可叠加（胶囊 y≈6dp vs 悬浮条 y=34dp，不重叠）。

### 6.4 权限引导与降级

- 设备现状：DSHA 悬浮窗权限此前被拒（约 21h 前）。首次执行任务且无权限时，发**一次性**引导通知，点击跳 `ACTION_MANAGE_OVERLAY_PERMISSION` 授权页。
- 未授权/关闭开关时降级为仅通知栏（即现状），不弹系统弹窗骚扰。

## 7. 验证策略

**单测**

- 新增 `util/AgentTaskIslandStateTest`（可见性/文案/计时/终态/多任务）。
- `PictureInPicturePolicyTest` 增 `taskActive` 用例。
- 删除/修改 4.1 所列 vscreen 测试后，全量 `:app:testStandardDebugUnitTest` 通过（注意：`--tests` 过滤只剩最后一个过滤集，勿据此判断全量；既有环境性失败：ColdInstallPackagesTest/TarGzipExtractorTest/TrialImportStop/TrialRecovery/UserDataBindings 与本次无关）。

**构建**

- `JAVA_HOME=<Android Studio jbr> DSHA_PYTHON=<Python312> ./gradlew.bat :app:compileStandardDebugUnitTest -x prepareRecoveryAssets -x verifyBxrootNative -x verifyBxrootProjection`，前后各跑一次 descriptor 刷新。

**真机验收清单（用户执行）**

1. 跑一个会启动应用的完整任务：**系统不重启**、DSHA **不进画中画**。
2. 灵动岛：执行中出现（阶段+计时）、点击回对话、长按请求停止、结束后对话自动回前台。
3. `/app/vscreen/*` 返回 404/不可用；agent 工具表无 `android_vscreen_*`。
4. 无任务时画中画行为与改前一致。

## 8. 回滚

- 改动 A/B/C 相互独立，可分别 `git revert`。
- B/C 均有开关：关开关即恢复原行为（B 无任务时本就一致；C 关开关回到纯通知栏）。

## 9. 文档更新

- 删除 `docs/virtual-screen-guide.md`；`docs/security-model.md` 改写一句。
- AGENTS.md 追加本轮决定：虚拟屏整体移除（含根因结论）、执行期禁画中画、灵动岛自绘胶囊（含系统胶囊不可达的取证结论）。
