import assert from "node:assert/strict";
import test from "node:test";
import {
  PICTURE_IN_PICTURE_CAPTURE_INTERVAL_MS,
  startPictureInPictureCapture,
  type PictureInPictureCaptureTimer,
  type PictureInPictureCaptureTimers,
  type PictureInPictureCaptureWindow,
} from "./picture-in-picture-capture";

type WindowEvent = "show" | "restore" | "hide" | "minimize" | "closed";

class FakeWindow implements PictureInPictureCaptureWindow {
  destroyed = false;
  visible = true;
  minimized = false;
  listeners = new Map<WindowEvent, Set<() => void>>();

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isVisible(): boolean {
    return this.visible;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  on(event: WindowEvent, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: WindowEvent, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: WindowEvent): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }

  hide(): void {
    this.visible = false;
    this.emit("hide");
  }

  show(): void {
    this.visible = true;
    this.emit("show");
  }

  minimize(): void {
    this.minimized = true;
    this.emit("minimize");
  }

  restore(): void {
    this.minimized = false;
    this.emit("restore");
  }

  close(): void {
    this.destroyed = true;
    this.emit("closed");
  }
}

interface FakeTimer extends PictureInPictureCaptureTimer {
  callback: () => void;
  delay: number;
  referenced: boolean;
}

class FakeTimers implements PictureInPictureCaptureTimers {
  timers = new Set<FakeTimer>();

  setInterval(callback: () => void, delay: number): FakeTimer {
    const timer: FakeTimer = {
      callback,
      delay,
      referenced: true,
      unref() {
        this.referenced = false;
      },
    };
    this.timers.add(timer);
    return timer;
  }

  clearInterval(handle: PictureInPictureCaptureTimer): void {
    this.timers.delete(handle as FakeTimer);
  }

  tick(): void {
    for (const timer of [...this.timers]) timer.callback();
  }
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("PiP capture removes its interval while hidden or minimized and resumes immediately", async () => {
  const window = new FakeWindow();
  const timers = new FakeTimers();
  let captures = 0;
  const stop = startPictureInPictureCapture(
    window,
    async () => {
      captures += 1;
    },
    timers,
  );

  await settle();
  assert.equal(captures, 1);
  assert.equal(timers.timers.size, 1);
  assert.equal([...timers.timers][0]?.delay, PICTURE_IN_PICTURE_CAPTURE_INTERVAL_MS);
  assert.equal([...timers.timers][0]?.referenced, false);

  window.hide();
  assert.equal(timers.timers.size, 0);
  timers.tick();
  assert.equal(captures, 1);

  window.show();
  await settle();
  assert.equal(captures, 2);
  assert.equal(timers.timers.size, 1);

  window.minimize();
  assert.equal(timers.timers.size, 0);
  window.restore();
  await settle();
  assert.equal(captures, 3);
  assert.equal(timers.timers.size, 1);

  stop();
  assert.equal(timers.timers.size, 0);
  assert.equal(
    [...window.listeners.values()].every((listeners) => listeners.size === 0),
    true,
  );
});

test("PiP capture serializes slow frames and stops permanently when closed", async () => {
  const window = new FakeWindow();
  const timers = new FakeTimers();
  const releases: Array<() => void> = [];
  let captures = 0;
  startPictureInPictureCapture(
    window,
    () => {
      captures += 1;
      return new Promise<void>((resolve) => releases.push(resolve));
    },
    timers,
  );

  assert.equal(captures, 1);
  timers.tick();
  timers.tick();
  window.minimize();
  window.restore();
  assert.equal(captures, 1);

  releases.shift()?.();
  await settle();
  assert.equal(captures, 2);

  window.close();
  releases.shift()?.();
  await settle();
  assert.equal(captures, 2);
  assert.equal(timers.timers.size, 0);
  assert.equal(
    [...window.listeners.values()].every((listeners) => listeners.size === 0),
    true,
  );
});
