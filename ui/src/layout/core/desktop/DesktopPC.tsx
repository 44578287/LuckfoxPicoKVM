/**
 * Compatibility shim retained so existing imports remain stable.
 *
 * First-connect reliability is now implemented directly in the PC/mobile
 * signaling paths with a synchronous PeerConnection ref and pending SDP/ICE
 * queues. Overlay isolation is structural in the video components.
 */
export function installWebRTCFirstConnectGuard() {
  // Intentionally empty.
}

export default function WebRTCReliabilityGuard() {
  return null;
}
