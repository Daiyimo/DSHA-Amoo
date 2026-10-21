package com.deepseekharness.app.util;

import android.app.ActivityOptions;
import android.os.Bundle;
import android.util.Log;

/**
 * StepOS 窗口模式适配：DSHA 经 /app/launch 拉起应用时显式请求全屏。
 *
 * StepOS 在 ActivityStarter 里挂了窗口模式钩子（StepOSMiniWindowControllerImpl），
 * 对不声明窗口模式的启动收进 stepos-mini-window（windowingMode=11，即用户看到的
 * 画中画）；显式请求 WINDOWING_MODE_FULLSCREEN 走标准 getOrCreateRootTask 路径，
 * 钩子不覆盖显式请求（am start --windowingMode 1 实测可把 mini-window 任务压回全屏）。
 *
 * setLaunchWindowingMode 是隐藏 API：反射被 hidden-API 策略拒绝或方法被移走时
 * available() 为 false，fullscreenOptions() 返回 null，调用方退回普通启动，
 * 行为与改造前完全一致。探测结果缓存，避免每次启动重复反射。
 */
public final class StepOsWindowMode {
  private StepOsWindowMode() {}

  private static final String TAG = "DSHA-Launch";
  /** WindowConfiguration.WINDOWING_MODE_FULLSCREEN；常量本身也是隐藏 API，直接写字面量。 */
  private static final int WINDOWING_MODE_FULLSCREEN = 1;

  private static java.lang.reflect.Method setLaunchWindowMode;
  private static Boolean available;

  /** 隐藏 API 是否可用；只在首次调用时探测并记日志。 */
  public static synchronized boolean available() {
    if (available == null) {
      try {
        setLaunchWindowMode = ActivityOptions.class.getMethod("setLaunchWindowingMode", int.class);
        available = Boolean.TRUE;
      } catch (Throwable missing) {
        // 缺失、被 hidden-API 策略拒绝、类被移走都算不可用，不抛给调用方。
        setLaunchWindowMode = null;
        available = Boolean.FALSE;
      }
      Log.i(TAG, "setLaunchWindowingMode 反射" + (available ? "可用" : "不可用，启动退回无窗口模式请求"));
    }
    return available;
  }

  /**
   * 返回带全屏窗口模式请求的 ActivityOptions Bundle；适配不可用时返回 null。
   * 调用方：options != null 时用 startActivity(intent, options)，否则用
   * startActivity(intent)，两条路径都不改变调用方原有的成功/失败语义。
   */
  public static Bundle fullscreenOptions() {
    if (!available()) return null;
    try {
      ActivityOptions options = ActivityOptions.makeBasic();
      setLaunchWindowMode.invoke(options, WINDOWING_MODE_FULLSCREEN);
      return options.toBundle();
    } catch (Throwable failure) {
      Log.w(TAG, "全屏窗口模式请求失败，本次退回普通启动：" + failure.getClass().getSimpleName());
      return null;
    }
  }
}
