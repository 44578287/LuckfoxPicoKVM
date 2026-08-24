import { useEffect } from "react";
import { flushSync } from "react-dom";

import { useRTCStore, useUiStore } from "@/hooks/stores";

let installed = false;
let nativeRTCPeerConnection: typeof RTCPeerConnection | null = null;

/**
 * Publish a newly-created RTCPeerConnection to the RTC store at construction
 * time, rather than waiting until the end of the vendor setupPeerConnection()
 * routine. The vendor websocket message handler captures peerConnection from a
 * React render closure and otherwise can see null when a very fast LAN answer
 * arrives during a cold first connection.
 *
 * We still wrap setPeerConnection as a second line of defence. The object we
 * return is the real browser RTCPeerConnection; this is not a proxy and does
 * not change WebRTC behaviour.
 */
export function installWebRTCFirstConnectGuard() {
  if (installed) return;
  installed = true;

  const originalSetPeerConnection = useRTCStore.getState().setPeerConnection;

  useRTCStore.setState({
    setPeerConnection: pc => {
      if (useRTCStore.getState().peerConnection === pc) return;
      if (pc === null) {
        originalSetPeerConnection(pc);
        return;
      }
      flushSync(() => {
        originalSetPeerConnection(pc);
      });
    },
  });

  // Publish the real PC synchronously at the exact point it is constructed.
  // This happens before transceivers/data channels can emit negotiationneeded
  // and therefore before an SDP answer can return from the device.
  nativeRTCPeerConnection = window.RTCPeerConnection;
  const NativePC = nativeRTCPeerConnection;
  if (!NativePC) return;

  const WrappedPC = function (configuration?: RTCConfiguration) {
    const pc = new NativePC(configuration);
    if (useRTCStore.getState().peerConnection !== pc) {
      flushSync(() => {
        originalSetPeerConnection(pc);
      });
    }
    return pc;
  } as unknown as typeof RTCPeerConnection;

  // Preserve instanceof/prototype/static behaviour expected by browser code.
  Object.setPrototypeOf(WrappedPC, NativePC);
  (WrappedPC as unknown as { prototype: RTCPeerConnection }).prototype = NativePC.prototype;
  Object.defineProperty(window, "RTCPeerConnection", {
    configurable: true,
    writable: true,
    value: WrappedPC,
  });
}

/**
 * Connection/loading overlays belong to the KVM canvas. They may explain a
 * failed video connection, but they must never sit above Settings, MCP, OTA or
 * recovery controls. The vendor PC layout gives the overlay z-20 while the
 * Settings popover is only z-10; lower the overlay into the video layer and
 * additionally hide it while a side panel is open.
 */
export default function WebRTCReliabilityGuard() {
  const sidebarView = useUiStore(state => state.sidebarView);

  useEffect(() => {
    const styleId = "picokvm-webrtc-access-guard";
    let style = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        .animate-slideUpFade.pointer-events-none.absolute.inset-0.z-20 {
          z-index: 5 !important;
        }

        body[data-picokvm-side-panel-open="true"]
        .animate-slideUpFade.pointer-events-none.absolute.inset-0.z-20 {
          opacity: 0 !important;
          visibility: hidden !important;
          pointer-events: none !important;
        }
      `;
      document.head.appendChild(style);
    }
  }, []);

  useEffect(() => {
    document.body.dataset.picokvmSidePanelOpen = sidebarView ? "true" : "false";
    return () => {
      delete document.body.dataset.picokvmSidePanelOpen;
    };
  }, [sidebarView]);

  return null;
}
