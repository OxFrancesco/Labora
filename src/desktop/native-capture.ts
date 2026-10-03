import { dlopen, FFIType } from "bun:ffi";
import { GpuixRenderer } from "@gpuix/native";

export function installNativeCaptureCleanup() {
  const runtime = dlopen("/usr/lib/libobjc.A.dylib", {
    objc_autoreleasePoolPush: { args: [], returns: FFIType.ptr },
    objc_autoreleasePoolPop: { args: [FFIType.ptr], returns: FFIType.void },
  });

  const capture = GpuixRenderer.prototype.captureScreenshot;

  // GPUix 0.10 captures outside AppKit's autorelease pool. Retained drawables
  // exhaust Metal's small buffer pool and block subsequent UI frames for a second.
  GpuixRenderer.prototype.captureScreenshot = function (path: string) {
    const pool = runtime.symbols.objc_autoreleasePoolPush();

    try { return capture.call(this, path); }
    finally { runtime.symbols.objc_autoreleasePoolPop(pool); }
  };
}
