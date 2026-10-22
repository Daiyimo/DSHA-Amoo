package com.deepseekharness.app.bridge;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import com.deepseekharness.app.ForegroundActivity;
import com.deepseekharness.app.util.BoundedUiCall;
import com.deepseekharness.app.util.SensitiveData;

/** 应用启动和剪贴板动作；授权由当前桥传入，不持有第二套运行或授权状态。 */
public final class AppDeviceActions {
  private AppDeviceActions() {}

  /** /app/launch?pkg=包名 ：启动应用（App 层，不需要 ADB） */
  public static String launch(
      Context ctx,
      String pkg,
      java.util.function.BiFunction<String, String, String> confirmationFailure,
      java.util.function.BooleanSupplier current) {
    boolean submitted = false;
    try {
      if (pkg.isEmpty()) return "NO_PKG";
      if (!current.getAsBoolean()) return "[ERR] SCREEN_RUN_CHANGED";
      String failure =
          confirmationFailure.apply(
              com.deepseekharness.app.util.UiText.format("启动应用：%s", pkg), pkg);
      if (failure != null) return "[ERR] " + failure;
      android.content.Intent i = ctx.getPackageManager().getLaunchIntentForPackage(pkg);
      if (i == null)
        return com.deepseekharness.app.util.UiText.format("NOT_FOUND: %s（该应用没有启动入口或未安装）", pkg);
      i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
      if (!current.getAsBoolean()) return "[ERR] SCREEN_RUN_CHANGED";
      submitted = true;
      ctx.startActivity(i);
      // StepOS 按调用方决定窗口模式：DSHA 拉起的应用被收进 stepos-mini-window
      // 画中画小窗，App 侧无法覆盖——setLaunchWindowingMode 反射被 hidden-API
      // 策略拒绝（logcat 实证 api=blocked），ActivityOptions 的 Bundle 键
      // （android:activity.windowingMode）实测到不了决策点（钩子收到 undefined）。
      // 全屏启动只能走设备 shell（shell uid 的 am 工具不受该钩子判定）：
      //   am start --windowingMode 1 包名
      //   解析不到时先 cmd package resolve-activity --brief 包名 再 -n 组件
      // 设备 shell 未配对（DEVICE_CHANNEL_UNAVAILABLE）时先在 DSHA 设置 →
      // 设备能力授权里连接 ADB 通道。
      return com.deepseekharness.app.util.UiText.format(
          "OK: 已启动 %s（StepOS 上进小窗；要全屏请用 adb-shell \"am start --windowingMode 1 %s\"，"
              + "shell 未配对时先在 设置 → 设备能力授权 连接 ADB）",
          pkg, pkg);
    } catch (Throwable e) {
      return (submitted ? "[RESULT_UNKNOWN] APP_LAUNCH_RESULT_UNKNOWN: " : "ERROR: ")
          + safeError(e);
    }
  }

  /** /app/clip 读剪贴板；/app/clip?text=xxx 写剪贴板 */
  public static String clipboard(Context ctx, Handler mainHandler, String text) {
    try {
      // HTTP 工作线程有界等待。不能在排队后先报成功，也不能因等待超时就假定尚未写入。
      if (Looper.myLooper() == Looper.getMainLooper())
        return com.deepseekharness.app.util.UiText.text("ERROR: 剪贴板桥需由请求工作线程调用");
      BoundedUiCall.Result<String> result =
          BoundedUiCall.call(
              new BoundedUiCall.Dispatcher() {
                @Override
                public boolean post(Runnable task) {
                  return mainHandler.post(task);
                }

                @Override
                public void remove(Runnable task) {
                  mainHandler.removeCallbacks(task);
                }
              },
              () -> {
                android.content.ClipboardManager cm =
                    (android.content.ClipboardManager)
                        ctx.getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm == null) return "NO_SERVICE";
                if (!text.isEmpty()) {
                  cm.setPrimaryClip(
                      com.deepseekharness.app.bridge.SensitiveClipboard.text("DSHA", text));
                  return com.deepseekharness.app.util.UiText.format(
                      "OK: 已写入剪贴板（%s 字）", text.length());
                }
                // 读取时复核真正前台窗口，WebView/Gecko 同样属于前台应用。
                if (!ForegroundActivity.isResumed(ForegroundActivity.current()))
                  return com.deepseekharness.app.util.UiText.text(
                      "[APP_BACKGROUND] 系统限制：只有 App 在前台时才能读剪贴板，可先用 /app/notify 提醒用户打开 DSHA");
                android.content.ClipData cd = cm.getPrimaryClip();
                if (cd == null || cd.getItemCount() == 0)
                  return com.deepseekharness.app.util.UiText.text("（剪贴板为空）");
                CharSequence cs = cd.getItemAt(0).coerceToText(ctx);
                String value = cs == null ? "" : cs.toString();
                return value.length() > 8192
                    ? com.deepseekharness.app.util.UiText.format(
                        "%s…（已截断）", value.substring(0, 8192))
                    : value;
              },
              3000);
      switch (result.status) {
        case SUCCESS:
          return result.value;
        case FAILED:
          return com.deepseekharness.app.util.UiText.format(
              "ERROR: 剪贴板操作失败：%s", safeError(result.error));
        case NOT_EXECUTED:
          return com.deepseekharness.app.util.UiText.format(
              "%s主线程尚未执行，已取消本次剪贴板操作；可重试", (result.interrupted ? "[INTERRUPTED] " : "[TIMEOUT] "));
        default:
          return com.deepseekharness.app.util.UiText.text(
              "[RESULT_UNKNOWN] 剪贴板操作已开始，但等待已结束，结果未知；请确认后再重试");
      }
    } catch (Throwable e) {
      return "ERROR: " + safeError(e);
    }
  }

  private static String safeError(Throwable error) {
    return SensitiveData.redact(String.valueOf(error));
  }
}
