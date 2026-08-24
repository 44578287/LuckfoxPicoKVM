import { useEffect } from "react";

function browserSupportsH265WebRTC() {
  try {
    const capabilities = RTCRtpReceiver.getCapabilities?.("video");
    if (!capabilities?.codecs?.length) return false;
    return capabilities.codecs.some(codec => {
      const mime = codec.mimeType.toLowerCase();
      return mime === "video/h265" || mime === "video/hevc";
    });
  } catch {
    return false;
  }
}

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

let rpcCounter = 900000;

async function rpc(method: string, params: object) {
  rpcCounter += 1;
  const response = await fetch("/api/rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-ID": getHttpSessionId(),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: rpcCounter }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const raw = await response.json();
  if (raw && typeof raw === "object" && "response" in raw) return raw.response;
  return raw;
}

// Browsers that do not advertise an H.265 WebRTC decoder can otherwise get
// stuck forever after ICE gathering while the KVM is configured for HEVC.
// Keep retrying quietly until the authenticated UI session is available; if
// the device is on HEVC, switch the global hardware encoder back to AVC before
// the next control WebRTC connection attempt.
export default function WebRTCCodecCompatibilityGuard() {
  useEffect(() => {
    if (browserSupportsH265WebRTC()) return;

    let cancelled = false;
    let timer: number | undefined;
    let attempts = 0;

    const check = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const current = await rpc("getStreamEncodecType", {});
        if (current?.error) throw new Error(current.error.data || current.error.message || "RPC failed");
        const codec = String(current?.result || "avc").toLowerCase();
        if (codec !== "hevc") return;

        console.warn("[WebRTC] Browser does not support H.265; falling back device stream to H.264/AVC");
        const changed = await rpc("setStreamEncodecType", { encodecType: "avc" });
        if (changed?.error) throw new Error(changed.error.data || changed.error.message || "RPC failed");
        if (!cancelled) {
          window.sessionStorage.setItem("picokvmAutoCodecFallback", "hevc-to-avc");
          window.location.reload();
        }
        return;
      } catch (error) {
        // Before local authentication completes /api/rpc can reject requests.
        // Retry for a while so the guard also works immediately after login.
        console.debug("[WebRTC] Codec compatibility preflight pending", error);
      }

      if (!cancelled && attempts < 30) {
        timer = window.setTimeout(check, 1000);
      }
    };

    void check();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  return null;
}

export { browserSupportsH265WebRTC };
