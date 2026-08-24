import { useEffect } from "react";

import { useVideoStore, VideoState } from "@/hooks/stores";

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
 * Reconcile the UI HDMI state independently from WebRTC signaling.
 *
 * The normal UI historically fetched getVideoState only once when the RPC
 * DataChannel opened, then relied on videoInputState notifications. If that
 * first request landed during startup and returned ready=false, the browser
 * could remain stuck on "no signal / not connected" until a full reload even
 * though video was already flowing. This lightweight HTTP-RPC reconciler makes
 * the displayed state eventually consistent without restarting WebRTC.
 */
export default function DeviceStateReconciler() {
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let rapidAttempts = 0;

    const reconcile = async () => {
      if (cancelled) return;

      try {
        const response = await rpc("getVideoState", {});
        if (response?.error) {
          throw new Error(response.error.data || response.error.message || "getVideoState failed");
        }
        if (response?.result && !cancelled) {
          useVideoStore.getState().setHdmiState(
            response.result as Parameters<VideoState["setHdmiState"]>[0],
          );
        }
      } catch (error) {
        // Authentication may not be available yet while the login route is
        // being rendered. Keep retrying quietly; once authenticated the same
        // component will converge the state without requiring an F5 reload.
        console.debug("[DeviceStateReconciler] video state pending", error);
      }

      rapidAttempts += 1;
      if (!cancelled) {
        // Fast convergence during initial page load, then inexpensive periodic
        // reconciliation in case a notification is ever missed later.
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
