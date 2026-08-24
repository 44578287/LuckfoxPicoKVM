import { useEffect } from "react";
import { flushSync } from "react-dom";

import { useRTCStore, useUiStore } from "@/hooks/stores";

let installed = false;

/**
 * The signaling handlers in the vendor UI read peerConnection from the React
 * render closure. Zustand itself updates synchronously, but React may not have
 * rendered the new selected value before a very fast LAN SDP answer arrives.
 * On a cold first load that can make `if (!peerConnection) return` discard the
 * answer. A full F5 changes timing and appears to "fix" the connection.
 *
 * Force only the non-null peerConnection publication through React flushSync.
 * This preserves the existing vendor signaling implementation while ensuring
 * the render closure is updated before the remote side can answer the offer.
 * Null cleanup remains normal/asynchronous to avoid flushSync during unmount.
 */
export function installWebRTCFirstConnectGuard() {
  if (installed) return;
  installed = true;

  const originalSetPeerConnection = useRTCStore.getState().setPeerConnection;
  useRTCStore.setState({
    setPeerConnection: pc => {
      if (pc === null) {
        originalSetPeerConnection(pc);
        return;
      }
      flushSync(() => {
        originalSetPeerConnection(pc);
      });
    },
  });
}

/**
 * Connection-error overlays are useful over the KVM canvas, but they must
 * never prevent the user from opening Settings/MCP/Update/diagnostic panels.
 * The existing layout renders the connection overlay above the desktop body;
 * hide that layer while any side panel is open.
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
