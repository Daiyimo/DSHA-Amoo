package com.deepseekharness.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

import com.deepseekharness.app.util.AgentTaskIslandState;
import com.deepseekharness.app.util.AgentTaskState;

import java.util.ArrayList;

/**
 * 屏幕顶部的任务胶囊（灵动岛）：agent 任务执行期间，DSHA 自己被全屏应用盖住时，
 * 用一颗小药丸显示任务阶段与计时。点一下回到对话，长按请求停止。
 *
 * <p><b>为什么自绘悬浮窗。</b> StepOS 的系统实时通知胶囊是包白名单制
 * （{@code Settings.System} 的 {@code stepos_app_support_livenotification_pkgs} 只有系统包），
 * 第三方应用无法把通知送进灵动岛（2026-10-23 真机实测：白名单内的 shell 包发持续通知，
 * 资格管线仍是 {@code eligible=0}）。所以走 {@code TYPE_APPLICATION_OVERLAY}：
 * 一次性授权、样式自控，与流式悬浮条 {@link OverlayController} 同一套机制。
 *
 * <p><b>不用 Service。</b> 悬浮窗只需要 {@code WindowManager} 和一个 View，调用方
 * （{@link AgentTaskNotifications}）本身就活在前台服务进程里。这里是纯静态控制器，
 * 生命周期跟着 App 进程，由任务通知的 1Hz 时钟驱动刷新。
 *
 * <p><b>触摸策略。</b> 胶囊本身收触摸（点=回对话、长按=停止），窗外触摸原样透传给
 * 下面的应用——执行期间主屏是目标应用，不能因为它少一块可点区域。
 */
public final class AgentTaskIsland {
  /** 总开关（配置页「显示任务状态胶囊」）。默认开：它取代了执行期间的画中画状态展示。 */
  public static final String K_ENABLED = "task_island";
  private static final String GUIDE_CHANNEL = "dsh_task_island_guide";
  private static final int GUIDE_ID = 2011;

  private static final Object LOCK = new Object();
  private static final Handler main = new Handler(Looper.getMainLooper());
  private static final java.util.concurrent.atomic.AtomicLong EPOCH =
      new java.util.concurrent.atomic.AtomicLong();

  private static WindowManager wm;
  private static View root;
  private static TextView label;
  private static boolean guiding;
  private static String boundTask = "";

  private AgentTaskIsland() {}

  private static SharedPreferences prefs(Context ctx) {
    return ctx.getSharedPreferences("deepseekharness", Context.MODE_PRIVATE);
  }

  public static boolean enabled(Context ctx) {
    try {
      return prefs(ctx).getBoolean(K_ENABLED, true);
    } catch (Throwable e) {
      return false;
    }
  }

  public static void setEnabled(Context ctx, boolean value) {
    prefs(ctx).edit().putBoolean(K_ENABLED, value).apply();
    if (!value) teardown(ctx);
  }

  /** 用户是否已授予悬浮窗权限。没权限时静默降级为通知栏，不弹系统弹窗骚扰。 */
  public static boolean permitted(Context ctx) {
    try {
      return Settings.canDrawOverlays(ctx);
    } catch (Throwable e) {
      return false;
    }
  }

  /**
   * 由任务通知的 1Hz 时钟调用：按当前任务状态显示/隐藏/更新胶囊。
   * 没权限但有任务在执行时，补发一次性引导通知（点它跳系统悬浮窗授权页）。
   */
  public static void refresh(Context ctx) {
    if (ctx == null) return;
    Context app = ctx.getApplicationContext();
    if (!enabled(app)) return;
    var view = resolve(app);
    if (view.visible()) {
      show(app, view);
      return;
    }
    hide();
    if (permitted(app)) cancelGuide(app);
    else if (hasActiveTask(app)) guidePermission(app);
  }

  /** 授权到手后把一次性引导通知撤掉，不留一条点过的通知挂在抽屉里。 */
  private static void cancelGuide(Context ctx) {
    var manager = (android.app.NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager != null) manager.cancel(GUIDE_ID);
  }

  private static boolean hasActiveTask(Context ctx) {
    try {
      return com.deepseekharness.app.AgentTaskNotifications.get(ctx).hasActiveTask();
    } catch (Throwable e) {
      return false;
    }
  }

  private static AgentTaskIslandState.View resolve(Context ctx) {
    var rows = com.deepseekharness.app.AgentTaskNotifications.get(ctx).snapshot();
    var inputs = new ArrayList<AgentTaskIslandState.Input>(rows.size());
    for (AgentTaskState.View row : rows) {
      inputs.add(
          new AgentTaskIslandState.Input(
              row.key().generation(),
              row.key().instance(),
              row.key().session(),
              row.key().turn(),
              row.key().owner(),
              row.action(),
              com.deepseekharness.app.AgentTaskNotifications.phase(row),
              row.active(),
              row.stopping(),
              row.started(),
              row.seen()));
    }
    return AgentTaskIslandState.resolve(
        inputs,
        com.deepseekharness.app.ForegroundActivity.current() != null,
        enabled(ctx),
        permitted(ctx),
        SystemClock.elapsedRealtime());
  }

  private static void show(Context ctx, AgentTaskIslandState.View view) {
    long epoch = EPOCH.get();
    main.post(
        () -> {
          if (epoch != EPOCH.get()) return;
          try {
            ensureView(ctx);
            if (root == null || label == null) return;
            var task = view.task();
            String text =
                "DSHA · "
                    + task.phaseText()
                    + (view.terminal() ? "" : " · " + view.elapsedSeconds() + "s");
            if (!text.contentEquals(label.getText())) label.setText(text);
            label.setTextColor(view.terminal() ? 0xFFB9C4D0 : Color.WHITE);
            // 监听只在任务切换时重绑：1Hz 刷新不必每秒换一遍 listener。
            String identity = task.generation() + "/" + task.turn() + "/" + task.action();
            if (!identity.equals(boundTask)) {
              boundTask = identity;
              bindActions(ctx, task);
            }
            if (root.getVisibility() != View.VISIBLE) root.setVisibility(View.VISIBLE);
          } catch (Throwable e) {
            android.util.Log.w("DSHA-Island", "任务胶囊更新失败", e);
          }
        });
  }

  /** 点击回对话、长按请求停止；两者都复用通知栏已有的同路径 Intent。 */
  private static void bindActions(Context ctx, AgentTaskIslandState.Input task) {
    root.setOnClickListener(
        v -> {
          try {
            ctx.startActivity(
                com.deepseekharness.app.ui.BrowserConversationRoute.conversation(
                        ctx, task.generation(), task.instance(), task.session())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
          } catch (RuntimeException unavailable) {
            // 预览宿主未就绪（运行时已停）时静默跳过：通知栏的「回聊天」仍可手动打开。
          }
        });
    root.setOnLongClickListener(
        v -> {
          // 与通知栏一致：只对仍在执行、且没在停止中的任务发起停止请求。
          if (!task.active() || task.stopping()) return true;
          try {
            ctx.sendBroadcast(stopIntent(ctx, task));
          } catch (RuntimeException unavailable) {
            android.util.Log.w("DSHA-Island", "任务停止请求发送失败", unavailable);
          }
          return true;
        });
  }

  /** 与通知栏「停止」按钮同一路径：显式广播给非导出的 AgentTaskStopReceiver。 */
  private static Intent stopIntent(Context ctx, AgentTaskIslandState.Input task) {
    return new Intent(ctx, com.deepseekharness.app.AgentTaskStopReceiver.class)
        .setData(Uri.parse("dsha-task://stop/" + task.action()))
        .putExtra("generation", task.generation())
        .putExtra("instance", task.instance())
        .putExtra("session", task.session())
        .putExtra("turn", task.turn())
        .putExtra("owner", task.owner())
        .putExtra("action", task.action());
  }

  private static void hide() {
    long epoch = EPOCH.get();
    main.post(
        () -> {
          if (epoch != EPOCH.get()) return;
          if (root != null) root.setVisibility(View.GONE);
        });
  }

  /** 关开关 / 撤权限时彻底移除窗口。 */
  public static void teardown(Context ctx) {
    EPOCH.incrementAndGet();
    main.post(
        () -> {
          try {
            if (wm != null && root != null) wm.removeViewImmediate(root);
          } catch (Throwable ignored) {
          }
          root = null;
          label = null;
          wm = null;
          boundTask = "";
        });
  }

  /** 首次执行任务却没有悬浮窗权限：发一条一次性引导，点它跳系统授权页。 */
  private static void guidePermission(Context ctx) {
    synchronized (LOCK) {
      if (guiding) return;
      guiding = true;
    }
    var manager = (android.app.NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager == null) return;
    if (Build.VERSION.SDK_INT >= 26)
      manager.createNotificationChannel(
          new android.app.NotificationChannel(
              GUIDE_CHANNEL,
              com.deepseekharness.app.util.UiText.choose("任务状态胶囊", "Task status capsule"),
              android.app.NotificationManager.IMPORTANCE_LOW));
    Intent grant =
        new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + ctx.getPackageName()))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    var notice =
        new androidx.core.app.NotificationCompat.Builder(ctx, GUIDE_CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher_v137)
            .setContentTitle(com.deepseekharness.app.util.UiText.choose("DSHA 任务", "DSHA task"))
            .setContentText(
                com.deepseekharness.app.util.UiText.choose(
                    "授予悬浮窗权限后，执行状态会显示在屏幕顶部的胶囊里",
                    "Grant the overlay permission to see task status in the top capsule"))
            .setContentIntent(
                android.app.PendingIntent.getActivity(
                    ctx,
                    0,
                    grant,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT
                        | android.app.PendingIntent.FLAG_IMMUTABLE))
            .setAutoCancel(true)
            .build();
    try {
      manager.notify(GUIDE_ID, notice);
    } catch (SecurityException denied) {
      /* 没有通知权限时静默跳过：任务进度通知同样不可用，属于同一处降级。 */
    }
  }

  private static void ensureView(Context ctx) {
    if (root != null) return;
    wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
    if (wm == null) return;

    TextView pill = new TextView(ctx);
    pill.setTextColor(Color.WHITE);
    pill.setTextSize(12f);
    pill.setIncludeFontPadding(false);
    pill.setSingleLine(true);
    int padH = dp(ctx, 14), padV = dp(ctx, 7);
    pill.setPadding(padH, padV, padH, padV);

    GradientDrawable shape = new GradientDrawable();
    shape.setCornerRadius(dp(ctx, 15));
    shape.setColor(0xE612161D);
    pill.setBackground(shape);

    WindowManager.LayoutParams lp = new WindowManager.LayoutParams();
    lp.type =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;
    // NOT_FOCUSABLE：不抢输入焦点；NOT_TOUCH_MODAL：胶囊以外的触摸透传给下面的应用。
    lp.flags =
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
            | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL;
    lp.format = PixelFormat.TRANSLUCENT;
    lp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
    lp.width = WindowManager.LayoutParams.WRAP_CONTENT;
    lp.height = WindowManager.LayoutParams.WRAP_CONTENT;
    lp.y = dp(ctx, 6); // 贴状态栏下沿：不遮时钟与刘海，也不抢下拉手势
    try {
      wm.addView(pill, lp);
      root = pill;
      label = pill;
    } catch (Throwable e) {
      // 权限被撤或某些 ROM 拒绝 → 安静降级，不影响 agent 干活
      android.util.Log.w("DSHA-Island", "任务胶囊创建失败（权限被撤？）", e);
      try {
        wm.removeViewImmediate(pill);
      } catch (RuntimeException unavailable) {
      }
      root = null;
      label = null;
      wm = null;
    }
  }

  private static int dp(Context ctx, int v) {
    return Math.round(v * ctx.getResources().getDisplayMetrics().density);
  }
}
