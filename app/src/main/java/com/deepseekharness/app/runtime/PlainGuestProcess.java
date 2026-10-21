package com.deepseekharness.app.runtime;

import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.TimeUnit;

/**
 * 无会话启动器的普通 guest 进程包装。
 *
 * <p>本机 libdsha-session 出生握手不稳定（实测 {@code PROCESS_BIRTH_RECHECK_UNCONFIRMED}：
 * 统计行能读到、会话核验不过），而 proot 本体与依赖库直接 exec 完全正常。本构建面向
 * 这台设备，{@link RuntimeLauncher} 绕过握手直接派生进程，用本类包装以满足调用方对
 * {@link OwnedGuestProof} 的引擎核验（{@code modeOf}）。
 *
 * <p>没有会话启动器监督，树退出证明不可用：{@link #confirmedTreeExit()} 恒为 false，
 * 调用方据此走「输出与退出码」的常规收尾路径。
 */
final class PlainGuestProcess extends Process implements OwnedGuestProof {
  private final Process delegate;
  private final String mode;

  PlainGuestProcess(Process delegate, String mode) {
    this.delegate = delegate;
    this.mode = mode;
  }

  @Override
  public String runtimeMode() {
    return mode;
  }

  @Override
  public boolean confirmedTreeExit() {
    return false;
  }

  @Override
  public OutputStream getOutputStream() {
    return delegate.getOutputStream();
  }

  @Override
  public InputStream getInputStream() {
    return delegate.getInputStream();
  }

  @Override
  public InputStream getErrorStream() {
    return delegate.getErrorStream();
  }

  @Override
  public int waitFor() throws InterruptedException {
    return delegate.waitFor();
  }

  @Override
  public boolean waitFor(long timeout, TimeUnit unit) throws InterruptedException {
    return delegate.waitFor(timeout, unit);
  }

  @Override
  public int exitValue() {
    return delegate.exitValue();
  }

  @Override
  public void destroy() {
    delegate.destroy();
  }
}
