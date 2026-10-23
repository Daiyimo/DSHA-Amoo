package com.deepseekharness.app.util;

import static org.junit.Assert.*;
import java.util.List;
import org.junit.Test;

public class AgentTaskIslandStateTest {
  private static AgentTaskIslandState.Input task(
      long generation, String phase, boolean active, long started, long seen) {
    return new AgentTaskIslandState.Input(
        generation, "instance-" + generation, "session-" + generation, generation,
        "0123456789abcdef0123456789abcdef", "action-" + generation, phase, active, false,
        started, seen);
  }

  @Test
  public void nothingToShowWithoutActiveOrFreshTerminalTask() {
    var hidden = AgentTaskIslandState.resolve(List.of(), false, true, true, 1_000);
    assertFalse(hidden.visible());
    var stale =
        AgentTaskIslandState.resolve(
            List.of(task(1, "任务完成", false, 0, 1_000)), false, true, true, 10_000);
    assertFalse(stale.visible());
  }

  @Test
  public void activeTaskShowsWhileDshaIsNotInForeground() {
    var view =
        AgentTaskIslandState.resolve(
            List.of(task(1, "正在执行工具", true, 9_000, 9_500)), false, true, true, 10_000);
    assertTrue(view.visible());
    assertEquals(1, view.elapsedSeconds());
    assertFalse(view.terminal());
  }

  @Test
  public void foregroundSwitchOrMissingPermissionHidesTheIsland() {
    var rows = List.of(task(1, "正在执行工具", true, 9_000, 9_500));
    assertFalse(AgentTaskIslandState.resolve(rows, true, true, true, 10_000).visible());
    assertFalse(AgentTaskIslandState.resolve(rows, false, false, true, 10_000).visible());
    assertFalse(AgentTaskIslandState.resolve(rows, false, true, false, 10_000).visible());
  }

  @Test
  public void newestActiveTaskWinsAndBeatsTerminalRows() {
    var older = task(1, "正在执行工具", true, 1_000, 9_000);
    var newer = task(2, "正在生成回复", true, 8_000, 9_500);
    var ended = task(3, "任务完成", false, 0, 9_900);
    var view =
        AgentTaskIslandState.resolve(List.of(older, newer, ended), false, true, true, 10_000);
    assertTrue(view.visible());
    assertEquals(2, view.task().generation());
    assertFalse(view.terminal());
  }

  @Test
  public void terminalTaskStaysForTheHoldWindowThenHides() {
    var ended = task(1, "任务完成", false, 0, 10_000);
    var during =
        AgentTaskIslandState.resolve(
            List.of(ended), false, true, true, 10_000 + AgentTaskIslandState.TERMINAL_HOLD_MS - 1);
    assertTrue(during.visible());
    assertTrue(during.terminal());
    var after =
        AgentTaskIslandState.resolve(
            List.of(ended), false, true, true, 10_000 + AgentTaskIslandState.TERMINAL_HOLD_MS + 1);
    assertFalse(after.visible());
  }

  @Test
  public void elapsedSecondsNeverGoesNegative() {
    var view =
        AgentTaskIslandState.resolve(
            List.of(task(1, "任务运行中", true, 10_000, 10_000)), false, true, true, 9_000);
    assertTrue(view.visible());
    assertEquals(0, view.elapsedSeconds());
  }
}
