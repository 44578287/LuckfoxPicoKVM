import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Outlet,
  redirect,
  useLoaderData,
  useLocation,
  useOutlet,
} from "react-router-dom";
import { useInterval } from "usehooks-ts";
import { FocusTrap } from "focus-trap-react";
import useWebSocket from "react-use-websocket";
import { useReactAt } from 'i18n-auto-extractor/react';
import semver from "semver";

import {
  HidState,
  KeyboardLedState,
  NetworkState,
  UpdateState,
  useDeviceStore,
  useHidStore,
  useMountMediaStore,
  useNetworkStateStore,
  User,
  useRTCStore,
  useUiStore,
  useUpdateStore,
  useVideoStore,
  VideoState,
  useSettingsStore,
 useVpnStore } from "@/hooks/stores";
import { JsonRpcRequest, useJsonRpc, resetHttpSessionId } from "@/hooks/useJsonRpc";
import { DEVICE_API } from "@/ui.config";
import api from "@/api";
import Modal from "@components/Modal";
import { useDeviceUiNavigation } from "@/hooks/useAppNavigation";
import {
  ConnectionFailedOverlay,
  LoadingConnectionOverlay,
  PeerConnectionDisconnectedOverlay,
} from "@components/VideoOverlay";
import { FeatureFlagProvider } from "@/providers/FeatureFlagProvider";
import notifications from "@/notifications";
import BarTop from "@/layout/core/bar_top/index";
import BottomBar from "@/layout/core/bar_bottom/index";
import { DeviceStatus } from "@routes/login_page/index";
import { LocalVersionInfo } from "@/layout/components_setting/version/VersionContent";
import Desktop from "@/layout/core/desktop/index";
import {  dark_bg_style_fun } from "@/layout/theme_color";
import SidebarContainer from "@/layout/core/bar_side";
import { useTheme } from "@/layout/contexts/ThemeContext";


import enJSON from '../locales/en.json';
import zhJSON from '../locales/zh.json';
interface LocalLoaderResp {
  authMode: "password" | "noPassword" | null;
}

interface CloudLoaderResp {
  deviceName: string;
  user: User | null;
  iceConfig: {
    iceServers: { credential?: string; urls: string | string[]; username?: string };
  } | null;
}

export type AuthMode = "password" | "noPassword" | null;
export interface LocalDevice {
  authMode: AuthMode;
  deviceId: string;
}

interface TailScaleResponse {
  state: string;
  loginUrl: string;
  ip: string;
  xEdge: boolean;
}

interface ZeroTierResponse {
  state: string;
  networkID: string;
  ip: string;
}

const deviceLoader = async () => {
  const res = await api
    .GET(`${DEVICE_API}/device/status`)
    .then(res => res.json() as Promise<DeviceStatus>);

  if (!res.isSetup) return redirect("/mode");

  const deviceRes = await api.GET(`${DEVICE_API}/device`);
  if (deviceRes.status === 401) return redirect("/login-local");
  if (deviceRes.ok) {
    const device = (await deviceRes.json()) as LocalDevice;
    return { authMode: device.authMode };
  }

  throw new Error("Error fetching device");
};

export default function PCHome() {
  const { $at } = useReactAt();
  const loaderResp = useLoaderData() as LocalLoaderResp | CloudLoaderResp;
  // Depending on the mode, we set the appropriate variables
  const iceConfig = "iceConfig" in loaderResp ? loaderResp.iceConfig : null;

  const sidebarView = useUiStore(state => state.sidebarView);
  const topBarView = useUiStore(state => state.topBarView);

  const setIsTurnServerInUse = useRTCStore(state => state.setTurnServerInUse);
  const peerConnection = useRTCStore(state => state.peerConnection);
  const setPeerConnectionState = useRTCStore(state => state.setPeerConnectionState);
  const peerConnectionState = useRTCStore(state => state.peerConnectionState);

  const setMediaMediaStream = useRTCStore(state => state.setMediaStream);
  const setPeerConnection = useRTCStore(state => state.setPeerConnection);
  const setDiskChannel = useRTCStore(state => state.setDiskChannel);
  const setRpcDataChannel = useRTCStore(state => state.setRpcDataChannel);
  const setTransceiver = useRTCStore(state => state.setTransceiver);
  const setAudioTransceiver = useRTCStore(state => state.setAudioTransceiver);
  const location = useLocation();

  const isLegacySignalingEnabled = useRef(false);

  const [connectionFailed, setConnectionFailed] = useState(false);

  const forceHttp = useSettingsStore(state => state.forceHttp);


  const { setOtaState } = useUpdateStore();
  const [isFullscreen, setIsFullscreen] = useState(0);
  const handleRequestFullscreen = async () => {
    setIsFullscreen(prevCount => prevCount + 1);
  };

  const [loadingMessage, setLoadingMessage] = useState("Connecting to device...");

  // Signaling must not depend on React render timing. A fast LAN answer can arrive while
  // setupPeerConnection is still awaiting ICE configuration and before Zustand causes a
  // render, so the websocket callback keeps its own synchronous PC reference and queues
  // signaling messages until the matching PeerConnection is ready.
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const pendingRemoteAnswerRef = useRef<RTCSessionDescriptionInit | null>(null);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const connectionWatchdogRef = useRef<number | null>(null);
  const takeoverNoticeRef = useRef(false);
  const setupPeerConnectionRef = useRef<() => Promise<void>>(async () => undefined);
  const automaticSessionRetryUsedRef = useRef(
    (() => {
      try {
        return window.sessionStorage.getItem("picokvm-webrtc-auto-retry") === "1";
      } catch {
        return false;
      }
    })(),
  );

  const clearConnectionWatchdog = useCallback(() => {
    if (connectionWatchdogRef.current === null) return;
    window.clearTimeout(connectionWatchdogRef.current);
    connectionWatchdogRef.current = null;
  }, []);

  const markConnectionHealthy = useCallback(() => {
    clearConnectionWatchdog();
    automaticSessionRetryUsedRef.current = false;
    try {
      window.sessionStorage.removeItem("picokvm-webrtc-auto-retry");
    } catch {
      // sessionStorage may be unavailable in hardened/private browser modes.
    }
    setConnectionFailed(false);
    setLoadingMessage("Connection established");
  }, [clearConnectionWatchdog]);

  const cleanupAndStopReconnecting = useCallback(
    function cleanupAndStopReconnecting(reason = "WebRTC connection failed") {
      const pc = peerConnectionRef.current;
      console.warn("[WebRTC] Closing peer connection:", reason, {
        connectionState: pc?.connectionState,
        iceConnectionState: pc?.iceConnectionState,
      });

      clearConnectionWatchdog();
      if (pc) setPeerConnectionState(pc.connectionState);
      if (pc && pc.signalingState !== "closed") pc.close();
      if (peerConnectionRef.current === pc) peerConnectionRef.current = null;
      setPeerConnection(null);

      // A page explicitly displaced by another controller must never reload itself and
      // fight to reclaim ownership. Ordinary first-connect failures get one bounded full
      // page retry, which also resets websocket/React state and removes the need for F5.
      if (!takeoverNoticeRef.current && !automaticSessionRetryUsedRef.current) {
        automaticSessionRetryUsedRef.current = true;
        try {
          window.sessionStorage.setItem("picokvm-webrtc-auto-retry", "1");
        } catch {
          // Best effort only; the in-memory flag still bounds this page instance.
        }
        window.location.reload();
        return;
      }

      setConnectionFailed(true);
    },
    [clearConnectionWatchdog, setPeerConnection, setPeerConnectionState],
   );

  const flushPendingIceCandidates = useCallback(async (pc: RTCPeerConnection) => {
    if (!pc.remoteDescription) return;
    const pending = pendingIceCandidatesRef.current.splice(0);
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        console.warn("[Websocket] Failed to add queued ICE candidate", error);
      }
    }
  }, []);

  const setRemoteSessionDescription = useCallback(
    async function setRemoteSessionDescription(
      pc: RTCPeerConnection,
      remoteDescription: RTCSessionDescriptionInit,
    ) {
      if (useSettingsStore.getState().forceHttp) {
        console.log("[setRemoteSessionDescription] Skipping due to HTTP fallback/force mode");
        return;
      }
      if (peerConnectionRef.current !== pc || pc.signalingState === "closed") return;

      setLoadingMessage("Setting remote description");
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(remoteDescription));
        await flushPendingIceCandidates(pc);
        console.log("[setRemoteSessionDescription] Remote description set successfully", {
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
        });
        setLoadingMessage("Establishing secure connection...");
      } catch (error) {
        console.error("[setRemoteSessionDescription] Failed to set remote description:", error);
        cleanupAndStopReconnecting("failed to apply remote SDP answer");
      }
    },
    [cleanupAndStopReconnecting, flushPendingIceCandidates],
  );

  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";

  const { sendMessage, getWebSocket } = useWebSocket(
    `${wsProtocol}//${window.location.host}/webrtc/signaling/client`,
    {
      heartbeat: true,
      retryOnError: true,
      reconnectAttempts: 30,
      reconnectInterval: 1000,
      onReconnectStop: () => {
        console.log("Reconnect stopped");
        cleanupAndStopReconnecting("signaling websocket reconnect limit reached");
      },
      shouldReconnect(event) {
        console.log("[Websocket] shouldReconnect", event);
        return !takeoverNoticeRef.current;
      },
      onClose(event) {
        console.log("[Websocket] onClose", event);
      },
      onError(event) {
        console.log("[Websocket] onError", event);
      },
      onOpen() {
        console.log("[Websocket] onOpen");
      },
      onMessage: async message => {
        if (message.data === "pong") return;

        const parsedMessage = JSON.parse(message.data);
        if (parsedMessage.type === "device-metadata") {
          const { deviceVersion } = parsedMessage.data;
          console.log("[Websocket] Received device-metadata message");
          console.log("[Websocket] Device version", deviceVersion);
          if (!deviceVersion) {
            console.log("[Websocket] Device is using legacy signaling");
            isLegacySignalingEnabled.current = true;
            getWebSocket()?.close();
          } else {
            console.log("[Websocket] Device is using new signaling");
            isLegacySignalingEnabled.current = false;
          }
          void setupPeerConnectionRef.current();
          return;
        }

        if (parsedMessage.type === "answer") {
          console.log("[Websocket] Received answer");
          const sd = atob(parsedMessage.data);
          const remoteSessionDescription = JSON.parse(sd) as RTCSessionDescriptionInit;
          const pc = peerConnectionRef.current;

          // Never drop an SDP answer just because React has not rendered the new PC yet.
          // Keep the newest answer and apply it as soon as the local offer exists.
          if (!pc || !pc.localDescription) {
            pendingRemoteAnswerRef.current = remoteSessionDescription;
            console.log("[Websocket] Queued answer until PeerConnection/local offer is ready");
            return;
          }
          if (pc.signalingState !== "have-local-offer") {
            console.warn("[Websocket] Ignoring duplicate/out-of-state answer", pc.signalingState);
            return;
          }
          await setRemoteSessionDescription(pc, remoteSessionDescription);
          return;
        }

        if (parsedMessage.type === "new-ice-candidate") {
          const candidate = parsedMessage.data as RTCIceCandidateInit;
          const pc = peerConnectionRef.current;
          if (!pc || !pc.remoteDescription) {
            pendingIceCandidatesRef.current.push(candidate);
            console.log("[Websocket] Queued ICE candidate until remote description is ready");
            return;
          }
          try {
            await pc.addIceCandidate(candidate);
          } catch (error) {
            console.warn("[Websocket] Failed to add ICE candidate", error);
          }
        }
      },
    },
    !connectionFailed && isLegacySignalingEnabled.current === false,
  );

  const sendWebRTCSignal = useCallback(
    (type: string, data: unknown) => {
      sendMessage(JSON.stringify({ type, data }), false);
    },
    [sendMessage],
  );

  const setupPeerConnection = useCallback(async () => {
    if (useSettingsStore.getState().forceHttp) {
      console.log("[setupPeerConnection] Skipping due to HTTP fallback/force mode");
      return;
    }

    takeoverNoticeRef.current = false;
    setConnectionFailed(false);
    setLoadingMessage("Connecting to device...");
    clearConnectionWatchdog();

    const previousPc = peerConnectionRef.current;
    if (previousPc && previousPc.signalingState !== "closed") previousPc.close();
    peerConnectionRef.current = null;
   pendingRemoteAnswerRef.current = null;
   pendingIceCandidatesRef.current = [];

  let pc: RTCPeerConnection;
  try {
    setLoadingMessage("Creating peer connection...");
    let fetchedIceServers: RTCIceServer[] = [];
    if (!iceConfig?.iceServers) {
      try {
        const res = await api.GET("/api/ice-servers");
        const data = await res.json();
        fetchedIceServers = data.iceServers ?? [];
      } catch (error) {
        console.error("failed to fetch ICE servers, fallback", error);
        fetchedIceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];
      }
    }

    pc = new RTCPeerConnection({
      ...(iceConfig?.iceServers
        ? { iceServers: [iceConfig.iceServers] }
        : { iceServers: fetchedIceServers }),
    });

    // Publish synchronously before transceivers/data channels can trigger negotiationneeded.
    // Signaling callbacks use this ref, not React state.
    peerConnectionRef.current = pc;
    setPeerConnection(pc);
    setPeerConnectionState(pc.connectionState);
    setLoadingMessage("Setting up connection to device...");
  } catch (error) {
    console.error("[setupPeerConnection] Error creating peer connection", error);
    cleanupAndStopReconnecting("failed to create PeerConnection");
    return;
  }

  pc.onconnectionstatechange = () => {
    if (peerConnectionRef.current !== pc) return;
    console.log("[setupPeerConnection] Connection state changed", pc.connectionState);
    setPeerConnectionState(pc.connectionState);
    if (pc.connectionState === "connected") {
      markConnectionHealthy();
    } else if (pc.connectionState === "failed") {
      cleanupAndStopReconnecting("RTCPeerConnection entered failed state");
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (peerConnectionRef.current !== pc) return;
    console.log("[setupPeerConnection] ICE state changed", pc.iceConnectionState);
    if (["connected", "completed"].includes(pc.iceConnectionState)) {
      markConnectionHealthy();
    } else if (pc.iceConnectionState === "failed") {
      cleanupAndStopReconnecting("ICE connection entered failed state");
    }
  };

  pc.onnegotiationneeded = async () => {
    if (peerConnectionRef.current !== pc) return;
    try {
      console.log("[setupPeerConnection] Creating offer");
      makingOffer.current = true;
      const offer = await pc.createOffer();
      if (peerConnectionRef.current !== pc || pc.signalingState === "closed") return;
      await pc.setLocalDescription(offer);
      const sd = btoa(JSON.stringify(pc.localDescription));
      if (isLegacySignalingEnabled.current === false) {
      sendWebRTCSignal("offer", { sd });
      } else {
        console.log("Legacy signaling. Waiting for ICE gathering to complete...");
      }

      const pendingAnswer = pendingRemoteAnswerRef.current;
      if (pendingAnswer && pc.signalingState === "have-local-offer") {
        pendingRemoteAnswerRef.current = null;
        await setRemoteSessionDescription(pc, pendingAnswer);
      }
    } catch (error) {
      console.error(return "setupPeerConnection createOffer", error);
      cleanupAndStopReconnecting("failed to create/send local SDP offer");
    } finally {
      makingOffer.current = false;
    }
  };

  pc.onicecandidate = async ({ candidate }) => {
    if (!candidate || candidate.candidate === "" || peerConnectionRef.current !== pc) return;
    sendWebRTCSignal("new-ice-candidate", candidate);
  };

  pc.onicegatheringstatechange = event => {
    const activePc = event.currentTarget as RTCPeerConnection;
    if (peerConnectionRef.current !== activePc) return;
    if (activePc.iceGatheringState === "complete") {
      setLoadingMessage("ICE Gathering completed");
    } else if (activePc.ice