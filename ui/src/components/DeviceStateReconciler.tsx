import { useEffect } from "react";

import { HidState, useHidStore, useVideoStore, VideoState } from "@/hooks/stores";

function getHttpSessionId() {
  try {
    const existing = window.sessionStorage.getItem("httpSessionId");
    if (existing) return existing;
    const generated = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    window.sessionStorage.setItem("httpSessionId", generated);
    return generated;
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

let rpcCounter = 940000;

async function rpc(method: string, params: object) {
  rpcCounter += 1;
  const response = await fetch("/api/rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-ID": getHttpSessionId(),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: rpcCounter }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const raw = await response.json();
  if (raw && typeof raw === "object" && "response" in raw) return raw.response;
  return raw;
}

/**
 * Reconcile the UI's device state independently from WebRTC notifications.
 *
 * Historically the normal WebRTC path fetched HDMI state only once when the
 * RPC DataChannel opened and did not fetch the current USB state at all. It
 * then relied on videoInputState/usbState change notifications. If the first
 * HDMI read landed during startup, or USB was already configured before the
 * browser connected, the page could remain stuck on "no output / detached"
 * until a full F5 reload. Periodic HTTP-RPC reconciliation makes both stores
 * eventually consistent without restarting WebRTC.
 */
export default function DeviceStateReconciler() {
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let rapidAttempts = 0;

    const reconcile = async () => {
      if (cancelled) return;

      const [videoResult, usbResult] = await Promise.allSettled([
        rpc("getVideoState", {}),
        rpc("getUSBState", {}),
      ]);

      if (videoResult.status === "fulfilled") {
        const response = videoResult.value;
        if (!response?.error && response?.result && !cancelled) {
          useVideoStore.getState().setHdmiState(
            response.result as Parameters<VideoState["setHdmiState"]>[0],
          );
        } else if (response?.error) {
          console.debug("[DeviceStateReconciler] video state pending", response.error);
        }
      } else {
        console.debug("[DeviceStateReconciler] video state pending", videoResult.reason);
      }

      if (usbResult.status === "fulfilled") {
        const response = usbResult.value;
        if (!response?.error && typeof response?.result === "string" && !cancelled) {
          useHidStore.getState().setUsbState(response.result as HidState["usbState"]);
        } else if (response?.error) {
          console.debug("[DeviceStateReconciler] USB state pending", response.error);
        }
      } else {
        console.debug("[DeviceStateReconciler] USB state pending", usbResult.reason);
      }

      rapidAttempts += 1;
      if (!cancelled) {
        // Fast convergence during login/initial WebRTC setup, then inexpensive
        // periodic reconciliation in case a state-change notification is lost.
        const delay = rapidAttempts <= 12 ? 750 : (document.hidden ? 15000 : 5000);
        timer = window.setTimeout(reconcile, delay);
      }
    };

    void reconcile();

    const onVisibility = () => {
      if (document.hidden || cancelled) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(reconcile, 0);
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
