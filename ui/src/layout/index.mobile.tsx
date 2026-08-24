import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Outlet,
  useLoaderData,
  useLocation,
  useNavigate,
  useOutlet,
  useSearchParams,
} from "react-router-dom";
import { useInterval } from "usehooks-ts";
import { FocusTrap } from "focus-trap-react";
import useWebSocket from "react-use-websocket";
import { isDesktop, isMobile } from "react-device-detect";
import {  Modal as AntdModal } from "antd";
import {useReactAt} from 'i18n-auto-extractor/react'
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
import { LocalVersionInfo } from "@/layout/components_setting/version/VersionContent";
import Desktop from "@/layout/core/desktop/index";
import { dark_bg_style_fun } from "@/layout/theme_color";
import SidebarContainer from "@/layout/core/bar_side";
import OtherSessionRoute from "@/layout/core/other-session";
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



export default function MobileHome() {
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

  // Signaling must not depend on React render timing. A fast LAN answer can
  // arrive while setupPeerConnection is still awaiting ICE configuration, so
  // the websocket callback keeps its own synchronous PC reference and queues
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

      // A page explicitly displaced by another controller must never reload
      // itself and fight for ownership again. For ordinary first-connect
      // failures, perform exactly one full-page retry so the user never needs F5.
      if (!takeoverNoticeRef.current && !automaticSessionRetryUsedRef.current) {
        automaticSessionRetryUsedRef.current = true;
        try {
          window.sessionStorage.setItem("picokvm-webrtc-auto-retry", "1");
        } catch {
          // Best effort only; the in-memory guard still bounds this page.
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

          // Never drop an SDP answer just because React has not rendered the new
          // PC yet. Keep the newest answer and apply it as soon as the local offer
          // exists.
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

      // Publish synchronously before transceivers/data channels can trigger
      // negotiationneeded. Signaling callbacks use this ref, not React state.
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
        const offer = await pc.createOffer();
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
        console.error("[setupPeerConnection] Error creating offer", error);
        cleanupAndStopReconnecting("failed to create/send local SDP offer");
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
      } else if (activePc.iceGatheringState === "gathering") {
        setLoadingMessage("Gathering ICE candidates...");
      }
    };

    pc.ontrack = event => {
      if (peerConnectionRef.current === pc) setMediaMediaStream(event.streams[0]);
    };

    setTransceiver(pc.addTransceiver("video", { direction: "recvonly" }));
    pc.addTransceiver("audio", { direction: "recvonly" });

    const rpcDataChannel = pc.createDataChannel("rpc");
    rpcDataChannel.onopen = () => {
      if (peerConnectionRef.current === pc) setRpcDataChannel(rpcDataChannel);
    };

    const diskDataChannel = pc.createDataChannel("disk");
    diskDataChannel.onopen = () => {
      if (peerConnectionRef.current === pc) setDiskChannel(diskDataChannel);
    };

    // Do not equate a slow SCTP channel with total WebRTC failure. Media/ICE
    // state is authoritative; after a bounded grace period a genuinely dead
    // first session gets exactly one automatic full-page retry.
    connectionWatchdogRef.current = window.setTimeout(() => {
      if (peerConnectionRef.current !== pc) return;
      const healthy =
        pc.connectionState === "connected" ||
        ["connected", "completed"].includes(pc.iceConnectionState);
      if (!healthy) cleanupAndStopReconnecting("connection watchdog expired");
    }, 15000);
  }, [
    cleanupAndStopReconnecting,
    clearConnectionWatchdog,
    iceConfig?.iceServers,
    markConnectionHealthy,
    sendWebRTCSignal,
    setAudioTransceiver,
    setDiskChannel,
    setMediaMediaStream,
    setPeerConnection,
    setPeerConnectionState,
    setRemoteSessionDescription,
    setRpcDataChannel,
    setTransceiver,
  ]);

  // The websocket callback is created before this callback in render order.
  // Keep the latest implementation in a ref so device-metadata never calls a
  // stale setup function.
  setupPeerConnectionRef.current = setupPeerConnection;

  useEffect(() => {
    if (peerConnectionState === "failed" && peerConnectionRef.current) {
      cleanupAndStopReconnecting("RTC store reported failed state");
    }
  }, [peerConnectionState, cleanupAndStopReconnecting]);

  // Cleanup effect
  const clearInboundRtpStats = useRTCStore(state => state.clearInboundRtpStats);
  const clearCandidatePairStats = useRTCStore(state => state.clearCandidatePairStats);
  const setSidebarView = useUiStore(state => state.setSidebarView);

  useEffect(() => {
    return () => {
      peerConnection?.close();
    };
  }, [peerConnection]);

  // For some reason, we have to have this unmount separate from the cleanup effect above
  useEffect(() => {
    return () => {
      clearInboundRtpStats();
      clearCandidatePairStats();
      setSidebarView(null);
      setPeerConnection(null);
    };
  }, [clearCandidatePairStats, clearInboundRtpStats, setPeerConnection, setSidebarView]);

  // TURN server usage detection
  useEffect(() => {
    if (peerConnectionState !== "connected") return;
    const { localCandidateStats, remoteCandidateStats } = useRTCStore.getState();

    const lastLocalStat = Array.from(localCandidateStats).pop();
    if (!lastLocalStat?.length) return;
    const localCandidateIsUsingTurn = lastLocalStat[1].candidateType === "relay"; // [0] is the timestamp, which we don't care about here

    const lastRemoteStat = Array.from(remoteCandidateStats).pop();
    if (!lastRemoteStat?.length) return;
    const remoteCandidateIsUsingTurn = lastRemoteStat[1].candidateType === "relay"; // [0] is the timestamp, which we don't care about here

    setIsTurnServerInUse(localCandidateIsUsingTurn || remoteCandidateIsUsingTurn);
  }, [peerConnectionState, setIsTurnServerInUse]);

  // Vpn State Update
  const tailScaleConnectionState = useVpnStore(state => state.tailScaleConnectionState);
  const setTailScaleConnectionState = useVpnStore(state => state.setTailScaleConnectionState);
  const setTailScaleXEdge = useVpnStore(state => state.setTailScaleXEdge);
  const setTailScaleLoginUrl = useVpnStore(state => state.setTailScaleLoginUrl);
  const setTailScaleIP = useVpnStore(state => state.setTailScaleIP);
  const zeroTierConnectionState = useVpnStore(state => state.zeroTierConnectionState);

  const setZeroTierConnectionState = useVpnStore(state => state.setZeroTierConnectionState);
  const setZeroTierNetworkID = useVpnStore(state => state.setZeroTierNetworkID);
  const setZeroTierIP = useVpnStore(state => state.setZeroTierIP);
  const otherSession = useUiStore(state => state.otherSession);
  const setOtherSession = useUiStore(state => state.setOtherSession);
  const setNetworkState = useNetworkStateStore(state => state.setNetworkState);

  const setUsbState = useHidStore(state => state.setUsbState);
  const setHdmiState = useVideoStore(state => state.setHdmiState);

  const keyboardLedState = useHidStore(state => state.keyboardLedState);
  const setKeyboardLedState = useHidStore(state => state.setKeyboardLedState);

  const setKeyboardLedStateSyncAvailable = useHidStore(state => state.setKeyboardLedStateSyncAvailable);

  const [hasUpdated, setHasUpdated] = useState(false);
  const [sessionInvalidated, setSessionInvalidated] = useState(false);
  const { navigateTo } = useDeviceUiNavigation();

  function onJsonRpcRequest(resp: JsonRpcRequest) {
    if (resp.method === "otherSessionConnected") {
      takeoverNoticeRef.current = true;
      setOtherSession(true);
    }

    if (resp.method === "sessionInvalidated") {
      takeoverNoticeRef.current = true;
      resetHttpSessionId();
      setSessionInvalidated(true);
      return;
    }

    if (resp.method === "usbState") {
      setUsbState(resp.params as unknown as HidState["usbState"]);
    }

    if (resp.method === "videoInputState") {
      setHdmiState(resp.params as Parameters<VideoState["setHdmiState"]>[0]);
    }

    if (resp.method === "networkState") {
      console.log("Setting network state", resp.params);
      setNetworkState(resp.params as NetworkState);
    }

    if (resp.method === "keyboardLedState") {
      const ledState = resp.params as KeyboardLedState;
      console.log("Setting keyboard led state", ledState);
      setKeyboardLedState(ledState);
      setKeyboardLedStateSyncAvailable(true);
    }

    if (resp.method === "otaState") {
      const otaState = resp.params as UpdateState["otaState"];
      setOtaState(otaState);

      if (otaState.updating === true) {
        setHasUpdated(true);
      }
    }
  }

  const rpcDataChannel = useRTCStore(state => state.rpcDataChannel);
  const [send] = useJsonRpc(onJsonRpcRequest);

  const updateVpnStates = useCallback(() => {
    // TailScaleState
    send("getTailScaleSettings", {}, resp => {
      if ("error" in resp) return;
      const result = resp.result as TailScaleResponse;
      const validState = ["closed", "connecting", "connected", "disconnected", "logined"].includes(result.state)
        ? result.state as "closed" | "connecting" | "connected" | "disconnected" | "logined"
        : "closed";

      setTailScaleXEdge(result.xEdge);
      setTailScaleConnectionState(validState);
      setTailScaleLoginUrl(result.loginUrl);
      setTailScaleIP(result.ip);
    });

    // ZeroTier
    if (zeroTierConnectionState !== "connecting" && zeroTierConnectionState !== "closed") {
      send("getZeroTierSettings", {}, resp => {
        if ("error" in resp) return;
        const result = resp.result as ZeroTierResponse;
        const validState = ["closed", "connecting", "connected", "disconnected", "logined"].includes(result.state)
          ? result.state as "closed" | "connecting" | "connected" | "disconnected" | "logined"
          : "closed";
        setZeroTierConnectionState(validState);
        setZeroTierNetworkID(result.networkID);
        setZeroTierIP(result.ip);
      });
    }
  }, [
    send,
    setTailScaleConnectionState,
    setTailScaleIP,
    setTailScaleLoginUrl,
    setTailScaleXEdge,
    setZeroTierConnectionState,
    setZeroTierIP,
    setZeroTierNetworkID,
    zeroTierConnectionState,
  ]);

  useEffect(() => {
    updateVpnStates();
  }, [updateVpnStates]);

  useInterval(updateVpnStates, 5000);

  const updateUsbState = useCallback(() => {
    send("getUSBState", {}, resp => {
      if ("error" in resp) return;
      setUsbState(resp.result as HidState["usbState"]);
    });
  }, [send, setUsbState]);

  const updateVideoState = useCallback(() => {
    send("getVideoState", {}, resp => {
      if ("error" in resp) return;
      setHdmiState(resp.result as Parameters<VideoState["setHdmiState"]>[0]);
    });
  }, [send, setHdmiState]);

  useEffect(() => {
    if (rpcDataChannel?.readyState !== "open") return;
    updateVideoState();
    updateVpnStates();
  }, [rpcDataChannel?.readyState, updateVideoState]);

  useEffect(() => {
    if (!forceHttp) return;
    updateVideoState();
    updateUsbState();
  }, [forceHttp, updateUsbState, updateVideoState]);

  useInterval(() => {
    updateVideoState();
    updateUsbState();
  }, forceHttp ? 1000 : null);

  // request keyboard led state from the device
  useEffect(() => {
    if (rpcDataChannel?.readyState !== "open") return;
    if (keyboardLedState !== undefined) return;
    console.log("Requesting keyboard led state");

    send("getKeyboardLedState", {}, resp => {
      if ("error" in resp) {
        // -32601 means the method is not supported
        if (resp.error.code === -32601) {
          setKeyboardLedStateSyncAvailable(false);
          console.error("Failed to get keyboard led state, disabling sync", resp.error);
        } else {
          console.error("Failed to get keyboard led state", resp.error);
        }
        return;
      }
      console.log("Keyboard led state", resp.result);
      setKeyboardLedState(resp.result as KeyboardLedState);
      setKeyboardLedStateSyncAvailable(true);
    });
  }, [rpcDataChannel?.readyState, send, setKeyboardLedState, setKeyboardLedStateSyncAvailable, keyboardLedState]);

  const diskChannel = useRTCStore(state => state.diskChannel)!;
  const file = useMountMediaStore(state => state.localFile)!;
  useEffect(() => {
    if (!diskChannel || !file) return;
    diskChannel.onmessage = async e => {
      console.log("Received", e.data);
      const data = JSON.parse(e.data);
      const blob = file.slice(data.start, data.end);
      const buf = await blob.arrayBuffer();
      const header = new ArrayBuffer(16);
      const headerView = new DataView(header);
      headerView.setBigUint64(0, BigInt(data.start), false); // start offset, big-endian
      headerView.setBigUint64(8, BigInt(buf.byteLength), false); // length, big-endian
      const fullData = new Uint8Array(header.byteLength + buf.byteLength);
      fullData.set(new Uint8Array(header), 0);
      fullData.set(new Uint8Array(buf), header.byteLength);
      diskChannel.send(fullData);
    };
  }, [diskChannel, file]);

  // System update
  const disableKeyboardFocusTrap = useUiStore(state => state.disableVideoFocusTrap);

  // const [kvmTerminal, setKvmTerminal] = useState<RTCDataChannel | null>(null);
  // const [serialConsole, setSerialConsole] = useState<RTCDataChannel | null>(null);



  const outlet = useOutlet();
  const onModalClose = useCallback(() => {
    if (location.pathname !== "/other-session") navigateTo("/");
  }, [navigateTo, location.pathname]);

  const appVersion = useDeviceStore(state => state.appVersion);
  const systemVersion = useDeviceStore(state => state.systemVersion);
  const setAppVersion = useDeviceStore(state => state.setAppVersion);
  const setSystemVersion = useDeviceStore(state => state.setSystemVersion);
  const [lowSystemVersionPromptDismissed, setLowSystemVersionPromptDismissed] = useState(false);

  useEffect(() => {
    if (appVersion && systemVersion) return;

    send("getLocalUpdateStatus", {}, async resp => {
      if ("error" in resp) {
        notifications.error(`Failed to get device version: ${resp.error}`);
        return
      }

      const result = resp.result as LocalVersionInfo;
      setAppVersion(result.appVersion);
      setSystemVersion(result.systemVersion);
    });
  }, [appVersion, send, setAppVersion, setSystemVersion, systemVersion]);

  const isSystemVersionTooLow = useMemo(() => {
    const baseCurrentVersion = semver.coerce(systemVersion ?? "")?.version;
    const baseMinVersion = semver.coerce("0.1.4")?.version;
    if (!baseCurrentVersion || !baseMinVersion) return false;
    return semver.lt(baseCurrentVersion, baseMinVersion);
  }, [systemVersion]);
  const hasConnectionFailed =
    connectionFailed || ["failed", "closed"].includes(peerConnectionState ?? "");
  const ConnectionStatusElement = useMemo(() => {


    const isPeerConnectionLoading =
      ["connecting", "new"].includes(peerConnectionState ?? "") ||
      peerConnection === null;

    const isDisconnected = peerConnectionState === "disconnected" && !forceHttp;

    const isOtherSession = location.pathname.includes("other-session");
    const hasActiveTopOrSidebar = topBarView !== null || sidebarView !== null;

    if (isOtherSession) return null;
    if (hasActiveTopOrSidebar) return null;
    if (peerConnectionState === "connected") return null;
    if (isDisconnected) {
      return <PeerConnectionDisconnectedOverlay show={true} />;
    }

    if (hasConnectionFailed)
      return (
        <ConnectionFailedOverlay show={true} setupPeerConnection={setupPeerConnection} />
      );
    if (forceHttp) return null;

    if (isPeerConnectionLoading) {
      return <LoadingConnectionOverlay show={true} text={loadingMessage} />;
    }

    return null;
  }, [
    connectionFailed,
    loadingMessage,
    location.pathname,
    peerConnection,
    peerConnectionState,
    setupPeerConnection,
    sidebarView,
    topBarView,
  ]);



const {isDark} = useTheme();

const language = useSettingsStore(state => state.language);
const { setCurrentLang } = useReactAt();
// Initialize Language
useEffect(() => {
  setCurrentLang(language, language === 'en' ? enJSON : zhJSON);
}, [language, setCurrentLang]);

  return (
    <FeatureFlagProvider appVersion={appVersion}>
      {sidebarView==null && topBarView == null && !hasConnectionFailed && isMobile}
      <div className="h-full overflow-hidden">

        {!lowSystemVersionPromptDismissed && isSystemVersionTooLow && (
          <div className="absolute inset-0 z-[19999] flex items-center justify-center bg-black/60">
            <div className="rounded-md bg-white px-6 py-4 text-center shadow-lg dark:bg-[#1a1a1a]">
              <p className="mb-2 text-base font-semibold text-slate-900 dark:text-white">
                {$at("Your system version is outdated (< 0.1.4)")}
              </p>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {$at("Please upgrade to the latest firmware as soon as possible.")}
              </p>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {$at("Current system version")}: {systemVersion}
              </p>
              <button
                className="mt-4 rounded bg-[rgba(22,152,217,1)] dark:bg-[rgba(45,106,229,1)] px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                onClick={() => setLowSystemVersionPromptDismissed(true)}
              >
                {$at("I understand")}
              </button>
            </div>
          </div>
        )}

        {sessionInvalidated && (
          <div className="absolute inset-0 z-[20000] flex items-center justify-center bg-black/60">
            <div className="rounded-md bg-white px-6 py-4 text-center shadow-lg dark:bg-slate-800">
              <p className="mb-2 text-base font-semibold text-slate-900 dark:text-white">
                {$at("The current page has been launched")}
              </p>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {$at("Please close this page or continue using the device in a new page.")}
              </p>
            </div>
          </div>
        )}

        <FocusTrap
          paused={disableKeyboardFocusTrap}
          focusTrapOptions={{
            allowOutsideClick: true,
            escapeDeactivates: false,
            fallbackFocus: "#videoFocusTrap",
          }}
        >
          <div className="absolute top-0">
            <button className="absolute top-0  bg-fuchsia-300" tabIndex={-1} id="videoFocusTrap" />
          </div>
        </FocusTrap>

        <div className={`grid h-full grid-rows-(--grid-headerBody) select-none ${dark_bg_style_fun(isDark)}`}>

          <BarTop requestFullscreen={handleRequestFullscreen} />


          <div className="relative flex h-full w-full overflow-hidden">
            <Desktop isFullscreen={isFullscreen} connectionOverlay={ConnectionStatusElement} />

            {isDesktop&&<SidebarContainer sidebarView={sidebarView} />}
          </div>
           {  sidebarView !== "Macros" &&   sidebarView !== "TerminalTabsMobile" &&   sidebarView !== "PowerControl"&&    <BottomBar />}

        </div>
      </div>

      <div
        className="z-50"
        onClick={e => e.stopPropagation()}
        onMouseUp={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
        onKeyUp={e => e.stopPropagation()}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === "Escape") navigateTo("/");
        }}
      >
        <Modal open={outlet !== null} onClose={onModalClose}>
          {/* The 'used by other session' modal needs to have access to the connectWebRTC function */}
          <Outlet context={{ setupPeerConnection }} />
        </Modal>
        <AntdModal
          open={otherSession}
          modalRender={OtherSessionRoute}
        >

        </AntdModal>
      </div>

    </FeatureFlagProvider>
  );
}
