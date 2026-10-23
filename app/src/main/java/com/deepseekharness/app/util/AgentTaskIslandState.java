package com.deepseekharness.app.util;

import java.util.List;

/**
 * 任务胶囊（灵动岛）的可见性与选行逻辑：不依赖 Android，可单测。
 *
 * <p>胶囊只在「有 agent 任务在执行、而 DSHA 自己不在前台」时出现——执行期间主屏留给
 * 目标应用，用户靠顶部这颗小胶囊看任务阶段。多任务并发时只显示最近活跃的那一个。
 */
public final class AgentTaskIslandState {
  /** 任务结束后的终态停留时长：让用户看见「任务完成/已停止」再淡出。 */
  public static final long TERMINAL_HOLD_MS = 3_000;

  private AgentTaskIslandState() {}

  /** 一个任务的最小展示输入；phase 文案由调用方按当前语言解析后传入。 */
  public record Input(
      long generation,
      String instance,
      String session,
      long turn,
      String owner,
      String action,
      String phaseText,
      boolean active,
      boolean stopping,
      long started,
      long seen) {}

  /** 胶囊应渲染的状态；{@code task == null} 时不可见。 */
  public record View(Input task, long elapsedSeconds, boolean terminal) {
    public boolean visible() {
      return task != null;
    }
  }

  /**
   * @param rows      当前全部任务视图（含终态）
   * @param foreground DSHA 是否在前台（前台时 App 自己显示状态，不弹胶囊）
   * @param enabled    用户总开关
   * @param permitted  是否已授予悬浮窗权限
   * @param now        单调时钟当前值（与 started/seen 同一时钟）
   */
  public static View resolve(
      List<Input> rows, boolean foreground, boolean enabled, boolean permitted, long now) {
    if (foreground || !enabled || !permitted || rows == null || rows.isEmpty()) return hidden();
    Input best = null;
    for (Input row : rows) {
      if (row.active()) {
        // 执行中：取开始最晚的那个。
        if (best == null || !best.active() || row.started() > best.started()) best = row;
      } else if (now - row.seen() <= TERMINAL_HOLD_MS) {
        // 终态停留窗口内：取最晚被看到的那个；执行中的任务优先于终态。
        if (best == null || !best.active() && row.seen() > best.seen()) best = row;
      }
    }
    if (best == null) return hidden();
    long elapsed = Math.max(0, (now - best.started()) / 1000);
    return new View(best, elapsed, !best.active());
  }

  private static View hidden() {
    return new View(null, 0, false);
  }
}
