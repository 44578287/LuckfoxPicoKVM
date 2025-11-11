import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LoaderFunctionArgs,
  Outlet,
  Params,
  redirect,
  useLoaderData,
  useLocation,
  useNavigate,
  useOutlet,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useInterval } from "usehooks-ts";
import { FocusTrap } from "focus-trap-react";
import { motion, AnimatePresence } from "framer-motion";
import useWebSocket from "react-use-websocket";

import { cx } from "@/cva.config";
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
} from "@/hooks/stores";
import WebRTCVideo from "@components/WebRTCVideo";
import { checkAuth, isInCloud, isOnDevice } from "@/main";
import DashboardNavbar from "@components/Header";
import ConnectionStatsSidebar from "@/components/sidebar/connectionStats";
import { JsonRpcRequest, useJsonRpc } from "@/hooks/useJsonRpc";
import Terminal from "@components/Terminal";
import { DEVICE_API } from "@/ui.config";

import UpdateInProgressStatusCard from "../components/UpdateInProgressStatusCard";
import api from "../api";
import Modal from "../components/Modal";
import { useDeviceUiNavigation } from "../hooks/useAppNavigation";
import {
  ConnectionFailedOverlay,
  LoadingConnectionOverlay,
  PeerConnectionDisconnectedOverlay,
} from "../components/VideoOverlay";
import { FeatureFlagProvider } from "../providers/FeatureFlagProvider";
import notifications from "../notifications";

import { DeviceStatus } from "./welcome-local";
import { SystemVersionInfo, LocalVersionInfo } from "./devices.$id.settings.general.update";

import { useVpnStore } from "@/hooks/stores";


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


const loader = async ({}: LoaderFunctionArgs) => {
  return deviceLoader();
};

export default function KvmIdRoute() {
  const loaderResp = useLoaderData() as LocalLoaderResp | CloudLoaderResp;
  // Depending on the mode, we set the appropriate variables
  const user = "user" in loaderResp ? loaderResp.user : null;
  const deviceName = "deviceName" in loaderResp ? loaderResp.deviceName : null;
  const iceConfig = "iceConfig" in loaderResp ? loaderResp.iceConfig : null;
  const authMode = "authMode" in loaderResp ? loaderResp.authMode : null;

  const params = useParams() as { id: string };
  const sidebarView = useUiStore(state => state.sidebarView);
  const [queryParams, setQueryParams] = useSearchParams();

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

  const navigate = useNavigate();
  const { otaState, setOtaState, setModalView } = useUpdateStore();

  const [loadingMessage, setLoadingMessage] = useState("Connecting to device...");
  const cleanupAndStopReconnecting = useCallback(
    function cleanupAndStopReconnecting() {
      console.log("Closing peer connection");

      setConnectionFailed(true);
      if (peerConnection) {
        setPeerConnectionState(peerConnection.connectionState);
      }
      connectionFailedRef.current = true;

      peerConnection?.close();
      signalingAttempts.current = 0;
    },
    [peerConnection, setPeerConnectionState],
  );

  // We need to track connectionFailed in a ref to avoid stale closure issues
  // This is necessary because syncRemoteSessionDescription is a callback that captures
  // the connectionFailed value at creation time, but we need the latest value
  // when the function is actually called. Without this ref, the function would use
  // a stale value of connectionFailed in some conditions.
  //
  // We still need the state variable for UI rendering, so we sync the ref with the state.
  // This pattern is a workaround for what useEvent hook would solve more elegantly
  // (which would give us a callback that always has access to latest state without re-creation).
  const connectionFailedRef = useRef(false);
  useEffect(() => {
    connectionFailedRef.current = connectionFailed;
  }, [connectionFailed]);

  const signalingAttempts = useRef(0);
  const setRemoteSessionDescription = useCallback(
    async function setRemoteSessionDescription(
      pc: RTCPeerConnection,
      remoteDescription: RTCSessionDescriptionInit,
    ) {
      setLoadingMessage("Setting remote description");

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(remoteDescription));
        console.log("[setRemoteSessionDescription] Remote description set successfully");
        setLoadingMessage("Establishing secure connection...");
      } catch (error) {
        console.error(
          "[setRemoteSessionDescription] Failed to set remote description:",
          error,
        );
        cleanupAndStopReconnecting();
        return;
      }

      // Replace the interval-based check with a more reliable approach
      let attempts = 0;
      const checkInterval = setInterval(() => {
        attempts++;

        // When vivaldi has disabled "Broadcast IP for Best WebRTC Performance", this never connects
        if (pc.sctp?.state === "connected") {
          console.log("[setRemoteSessionDescription] Remote description set");
          clearInterval(checkInterval);
          setLoadingMessage("Connection established");
        } else if (attempts >= 10) {
          console.log(
            "[setRemoteSessionDescription] Failed to establish connection after 10 attempts",
            {
              connectionState: pc.connectionState,
              iceConnectionState: pc.iceConnectionState,
            },
          );
          cleanupAndStopReconnecting();
          clearInterval(checkInterval);
        } else {
          console.log("[setRemoteSessionDescription] Waiting for connection, state:", {
            connectionState: pc.connectionState,
            iceConnectionState: pc.iceConnectionState,
          });
        }
      }, 1000);
    },
    [cleanupAndStopReconnecting],
  );

  const ignoreOffer = useRef(false);
  const isSettingRemoteAnswerPending = useRef(false);
  const makingOffer = useRef(false);

  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";

  const { sendMessage, getWebSocket } = useWebSocket(
    //`${wsProtocol}//${window.location.host}/webrtc/signaling/client?id=${params.id}`,
    `${wsProtocol}//${window.location.host}/webrtc/signaling/client`,
    {
      heartbeat: true,
      retryOnError: true,
      reconnectAttempts: 15,
      reconnectInterval: 1000,
      onReconnectStop: () => {
        console.log("Reconnect stopped");
        cleanupAndStopReconnecting();
      },

      shouldReconnect(event) {
        console.log("[Websocket] shouldReconnect", event);
        // TODO: Why true?
        return true;
      },

      onClose(event) {
        console.log("[Websocket] onClose", event);
        // We don't want to close everything down, we wait for the reconnect to stop instead
      },

      onError(event) {
        console.log("[Websocket] onError", event);
        // We don't want to close everything down, we wait for the reconnect to stop instead
      },
      onOpen() {
        console.log("[Websocket] onOpen");
      },

      onMessage: message => {
        if (message.data === "pong") return;

        /*
          Currently the signaling process is as follows:
            After open, the other side will send a `device-metadata` message with the device version
            If the device version is not set, we can assume the device is using the legacy signaling
            Otherwise, we can assume the device is using the new signaling

            If the device is using the legacy signaling, we close the websocket connection
            and use the legacy HTTPSignaling function to get the remote session description

            If the device is using the new signaling, we don't need to do anything special, but continue to use the websocket connection
            to chat with the other peer about the connection
        */

        const parsedMessage = JSON.parse(message.data);
        if (parsedMessage.type === "device-metadata") {
          const { deviceVersion } = parsedMessage.data;
          console.log("[Websocket] Received device-metadata message");
          console.log("[Websocket] Device version", deviceVersion);
          // If the device version is not set, we can assume the device is using the legacy signaling
          if (!deviceVersion) {
            console.log("[Websocket] Device is using legacy signaling");

            // Now we don't need the websocket connection anymore, as we've established that we need to use the legacy signaling
            // which does everything over HTTP(at least from the perspective of the client)
            isLegacySignalingEnabled.current = true;
            getWebSocket()?.close();
          } else {
            console.log("[Websocket] Device is using new signaling");
            isLegacySignalingEnabled.current = false;
          }
          setupPeerConnection();
        }

        if (!peerConnection) return;
        if (parsedMessage.type === "answer") {
          console.log("[Websocket] Received answer");
          const readyForOffer =
            // If we're making an offer, we don't want to accept an answer
            !makingOffer &&
            // If the peer connection is stable or we're setting the remote answer pending, we're ready for an offer
            (peerConnection?.signalingState === "stable" ||
              isSettingRemoteAnswerPending.current);

          // If we're not ready for an offer, we don't want to accept an offer
          ignoreOffer.current = parsedMessage.type === "offer" && !readyForOffer;
          if (ignoreOffer.current) return;

          // Set so we don't accept an answer while we're setting the remote description
          isSettingRemoteAnswerPending.current = parsedMessage.type === "answer";
          console.log(
            "[Websocket] Setting remote answer pending",
            isSettingRemoteAnswerPending.current,
          );

          const sd = atob(parsedMessage.data);
          const remoteSessionDescription = JSON.parse(sd);

          setRemoteSessionDescription(
            peerConnection,
            new RTCSessionDescription(remoteSessionDescription),
          );

          // Reset the remote answer pending flag
          isSettingRemoteAnswerPending.current = false;
        } else if (parsedMessage.type === "new-ice-candidate") {
          console.log("[Websocket] Received new-ice-candidate");
          const candidate = parsedMessage.data;
          peerConnection.addIceCandidate(candidate);
        }
      },
    },

    // Don't even retry once we declare failure
    !connectionFailed && isLegacySignalingEnabled.current === false,
  );

  const sendWebRTCSignal = useCallback(
    (type: string, data: unknown) => {
      // Second argument tells the library not to queue the message, and send it once the connection is established again.
      // We have event handlers that handle the connection set up, so we don't need to queue the message.
      sendMessage(JSON.stringify({ type, data }), false);
    },
    [sendMessage],
  );

  const setupPeerConnection = useCallback(async () => {
    console.log("[setupPeerConnection] Setting up peer connection");
    setConnectionFailed(false);
    setLoadingMessage("Connecting to device...");

    let pc: RTCPeerConnection;
    try {
      console.log("[setupPeerConnection] Creating peer connection");
      setLoadingMessage("Creating peer connection...");
      pc = new RTCPeerConnection({
        // We only use STUN or TURN servers if we're in the cloud
        //...(isInCloud && iceConfig?.iceServers
        //  ? { iceServers: [iceConfig?.iceServers] }
        //  : {}),
        ...(iceConfig?.iceServers 
        ? { iceServers: [iceConfig?.iceServers] }
        : {
          iceServers: [
            {
              urls: ['stun:stun.l.google.com:19302']
            }
          ]
        }),
      });

      setPeerConnectionState(pc.connectionState);
      console.log("[setupPeerConnection] Peer connection created", pc);
      setLoadingMessage("Setting up connection to device...");
    } catch (e) {
      console.error(`[setupPeerConnection] Error creating peer connection: ${e}`);
      setTimeout(() => {
        cleanupAndStopReconnecting();
      }, 1000);
      return;
    }

    // Set up event listeners and data channels
    pc.onconnectionstatechange = () => {
      console.log("[setupPeerConnection] Connection state changed", pc.connectionState);
      setPeerConnectionState(pc.connectionState);
    };

    pc.onnegotiationneeded = async () => {
      try {
        console.log("[setupPeerConnection] Creating offer");
        makingOffer.current = true;

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const sd = btoa(JSON.stringify(pc.localDescription));
        const isNewSignalingEnabled = isLegacySignalingEnabled.current === false;
        if (isNewSignalingEnabled) {
          sendWebRTCSignal("offer", { sd: sd });
        } else {
          console.log("Legacy signanling. Waiting for ICE Gathering to complete...");
        }
      } catch (e) {
        console.error(
          `[setupPeerConnection] Error creating offer: ${e}`,
          new Date().toISOString(),
        );
        cleanupAndStopReconnecting();
      } finally {
        makingOffer.current = false;
      }
    };

    pc.onicecandidate = async ({ candidate }) => {
      if (!candidate) return;
      if (candidate.candidate === "") return;
      sendWebRTCSignal("new-ice-candidate", candidate);
    };

    pc.onicegatheringstatechange = event => {
      const pc = event.currentTarget as RTCPeerConnection;
      if (pc.iceGatheringState === "complete") {
        console.log("ICE Gathering completed");
        setLoadingMessage("ICE Gathering completed");

      } else if (pc.iceGatheringState === "gathering") {
        console.log("ICE Gathering Started");
        setLoadingMessage("Gathering ICE candidates...");
      }
    };

    pc.ontrack = function (event) {
      setMediaMediaStream(event.streams[0]);
    };

    setTransceiver(pc.addTransceiver("video", { direction: "recvonly" }));
    pc.addTransceiver("audio", { direction: "recvonly" });

    const rpcDataChannel = pc.createDataChannel("rpc");
    rpcDataChannel.onopen = () => {
      setRpcDataChannel(rpcDataChannel);
    };

    const diskDataChannel = pc.createDataChannel("disk");
    diskDataChannel.onopen = () => {
      setDiskChannel(diskDataChannel);
    };

    setPeerConnection(pc);
  }, [
    cleanupAndStopReconnecting,
    iceConfig?.iceServers,
    sendWebRTCSignal,
    setDiskChannel,
    setMediaMediaStream,
    setPeerConnection,
    setPeerConnectionState,
    setRpcDataChannel,
    setTransceiver,
    setAudioTransceiver,
  ]);

  useEffect(() => {
    if (peerConnectionState === "failed") {
      console.log("Connection failed, closing peer connection");
      cleanupAndStopReconnecting();
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
  const tailScaleXEdge = useVpnStore(state => state.tailScaleXEdge);
  const setTailScaleXEdge = useVpnStore(state => state.setTailScaleXEdge);
  const setTailScaleLoginUrl = useVpnStore(state => state.setTailScaleLoginUrl); 
  
  const setTailScaleIP = useVpnStore(state => state.setTailScaleIP);

  const zeroTierConnectionState = useVpnStore(state => state.zeroTierConnectionState);
  const zeroTierNetworkID = useVpnStore(state => state.zeroTierNetworkID);
  const setZeroTierConnectionState = useVpnStore(state => state.setZeroTierConnectionState); 
  const setZeroTierNetworkID = useVpnStore(state => state.setZeroTierNetworkID);
  const setZeroTierIP = useVpnStore(state => state.setZeroTierIP);
 
  const updateVpnStates = () => {
    // TailScaleState
    if (tailScaleConnectionState !== "connecting" && tailScaleConnectionState !== "closed") {
      send("getTailScaleSettings", {}, resp => {
        if ("error" in resp) return;
        const result = resp.result as TailScaleResponse;
        const validState = ["closed", "connecting", "connected", "disconnected", "logined"].includes(result.state)
          ? result.state as "closed" | "connecting" | "connected" | "disconnected" | "logined"
          : "closed";

        if(tailScaleConnectionState !== "disconnected" ) {
          setTailScaleXEdge(result.xEdge);
        }
        setTailScaleConnectionState(validState);
        setTailScaleLoginUrl(result.loginUrl);
        setTailScaleIP(result.ip);
      });
    }
    
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
  }

  useInterval(updateVpnStates, 5000);

  const setNetworkState = useNetworkStateStore(state => state.setNetworkState);

  const setUsbState = useHidStore(state => state.setUsbState);
  const usbState = useHidStore(state => state.usbState);
  const setHdmiState = useVideoStore(state => state.setHdmiState);

  const keyboardLedState = useHidStore(state => state.keyboardLedState);
  const setKeyboardLedState = useHidStore(state => state.setKeyboardLedState);
  const setKeyboardLedStateSyncAvailable = useHidStore(state => state.setKeyboardLedStateSyncAvailable);
  const setIsReinitializingGadget = useHidStore(state => state.setIsReinitializingGadget);

  const [hasUpdated, setHasUpdated] = useState(false);
  const { navigateTo } = useDeviceUiNavigation();

  function onJsonRpcRequest(resp: JsonRpcRequest) {
    if (resp.method === "otherSessionConnected") {
      navigateTo("/other-session");
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

    if (resp.method === "hidDeviceMissing") {
      const params = resp.params as { device: string; error: string };
      console.error("HID device missing:", params);
      
      send("getUsbEmulationState", {}, stateResp => {
        if ("error" in stateResp) return;
        const emuEnabled = stateResp.result as boolean;
        if (!emuEnabled || usbState !== "configured") {
          return;
        }

        setIsReinitializingGadget(true);

        notifications.error(
          `USB HID device (${params.device}) is missing. Reinitializing USB gadget...`,
          { duration: 5000 }
        );

        send("reinitializeUsbGadgetSoft", {}, (resp) => {
          setIsReinitializingGadget(false);
          
          if ("error" in resp) {
            notifications.error(
              `Failed to reinitialize USB gadget (soft): ${resp.error.message}`,
              { duration: 5000 }
            );
          } else {
            notifications.success(
              "USB gadget soft reinitialized successfully",
              { duration: 3000 }
            );
          }
        });
      });
    }

    if (resp.method === "otaState") {
      const otaState = resp.params as UpdateState["otaState"];
      setOtaState(otaState);

      if (otaState.updating === true) {
        setHasUpdated(true);
      }

      if (hasUpdated && otaState.updating === false) {
        setHasUpdated(false);

        if (otaState.error) {
          setModalView("error");
          navigateTo("/settings/general/update");
          return;
        }

        const currentUrl = new URL(window.location.href);
        currentUrl.search = "";
        currentUrl.searchParams.set("updateSuccess", "true");
        window.location.href = currentUrl.toString();
      }
    }

    if (resp.method === "refreshPage") {
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.set("networkChanged", "true");
      window.location.href = currentUrl.toString();
    }
  }

  const rpcDataChannel = useRTCStore(state => state.rpcDataChannel);
  const [send] = useJsonRpc(onJsonRpcRequest);

  useEffect(() => {
    if (rpcDataChannel?.readyState !== "open") return;
    send("getVideoState", {}, resp => {
      if ("error" in resp) return;
      setHdmiState(resp.result as Parameters<VideoState["setHdmiState"]>[0]);
    });
    updateVpnStates();
  }, [rpcDataChannel?.readyState, send, setHdmiState]);

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

  // When the update is successful, we need to refresh the client javascript and show a success modal
  useEffect(() => {
    if (queryParams.get("updateSuccess")) {
      navigateTo("/settings/general/update", { state: { updateSuccess: true } });
    }
  }, [navigate, navigateTo, queryParams, setModalView, setQueryParams]);

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

  const [kvmTerminal, setKvmTerminal] = useState<RTCDataChannel | null>(null);
  const [serialConsole, setSerialConsole] = useState<RTCDataChannel | null>(null);

  useEffect(() => {
    if (!peerConnection) return;
    //if (!kvmTerminal) {
    //  setKvmTerminal(peerConnection.createDataChannel("terminal"));
    //}

    //if (!serialConsole) {
    //  setSerialConsole(peerConnection.createDataChannel("serial"));
    //}
    const terminalChannel = peerConnection.createDataChannel("terminal");
    setKvmTerminal(terminalChannel);
    const serialChannel = peerConnection.createDataChannel("serial");
    setSerialConsole(serialChannel);

  //}, [kvmTerminal, peerConnection, serialConsole]);
  }, [peerConnection]);

  const outlet = useOutlet();
  const onModalClose = useCallback(() => {
    if (location.pathname !== "/other-session") navigateTo("/");
  }, [navigateTo, location.pathname]);

  const appVersion = useDeviceStore(state => state.appVersion);
  const setAppVersion = useDeviceStore(state => state.setAppVersion);
  const setSystemVersion = useDeviceStore(state => state.setSystemVersion);

  useEffect(() => {
    if (appVersion) return;

    send("getLocalUpdateStatus", {}, async resp => {
      if ("error" in resp) {
        notifications.error(`Failed to get device version: ${resp.error}`);
        return 
      }

      const result = resp.result as LocalVersionInfo;
      setAppVersion(result.appVersion);
      setSystemVersion(result.systemVersion);
    });
  }, [appVersion, send, setAppVersion, setSystemVersion]);

  const ConnectionStatusElement = useMemo(() => {
    const hasConnectionFailed =
      connectionFailed || ["failed", "closed"].includes(peerConnectionState ?? "");

    const isPeerConnectionLoading =
      ["connecting", "new"].includes(peerConnectionState ?? "") ||
      peerConnection === null;

    const isDisconnected = peerConnectionState === "disconnected";

    const isOtherSession = location.pathname.includes("other-session");

    if (isOtherSession) return null;
    if (peerConnectionState === "connected") return null;
    if (isDisconnected) {
      return <PeerConnectionDisconnectedOverlay show={true} />;
    }

    if (hasConnectionFailed)
      return (
        <ConnectionFailedOverlay show={true} setupPeerConnection={setupPeerConnection} />
      );

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
  ]);

  return (
    <FeatureFlagProvider appVersion={appVersion}>
      {!outlet && otaState.updating && (
        <AnimatePresence>
          <motion.div
            className="pointer-events-none fixed inset-0 top-16 z-10 mx-auto flex h-full w-full max-w-xl translate-y-8 items-start justify-center"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
          >
            <UpdateInProgressStatusCard />
          </motion.div>
        </AnimatePresence>
      )}
      <div className="relative h-full">
        <FocusTrap
          paused={disableKeyboardFocusTrap}
          focusTrapOptions={{
            allowOutsideClick: true,
            escapeDeactivates: false,
            fallbackFocus: "#videoFocusTrap",
          }}
        >
          <div className="absolute top-0">
            <button className="absolute top-0" tabIndex={-1} id="videoFocusTrap" />
          </div>
        </FocusTrap>

        <div className="grid h-full grid-rows-(--grid-headerBody) select-none">
          <DashboardNavbar
            primaryLinks={isOnDevice ? [] : [{ title: "Cloud Devices", to: "/devices" }]}
            showConnectionStatus={true}
            isLoggedIn={authMode === "password" || !!user}
            userEmail={user?.email}
            picture={user?.picture}
            kvmName={deviceName ?? "KVM Device"}
          />

          <div className="relative flex h-full w-full overflow-hidden">
            <WebRTCVideo />
            <div
              style={{ animationDuration: "500ms" }}
              className="animate-slideUpFade pointer-events-none absolute inset-0 flex items-center justify-center p-4"
            >
              <div className="relative h-full max-h-[720px] w-full max-w-[1280px] rounded-md">
                {!!ConnectionStatusElement && ConnectionStatusElement}
              </div>
            </div>
            <SidebarContainer sidebarView={sidebarView} />
          </div>
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
      </div>

      {kvmTerminal && (
        <Terminal type="kvm" dataChannel={kvmTerminal} title="KVM Terminal" />
      )}

      {serialConsole && (
        <Terminal type="serial" dataChannel={serialConsole} title="Serial Console" />
      )}
    </FeatureFlagProvider>
  );
}

interface SidebarContainerProps {
  readonly sidebarView: string | null;
}

function SidebarContainer(props: SidebarContainerProps) {
  const { sidebarView }= props;
  return (
    <div
      className={cx(
        "flex shrink-0 border-l border-l-slate-800/20 transition-all duration-500 ease-in-out dark:border-l-slate-300/20",
        { "border-x-transparent": !sidebarView },
      )}
      style={{ width: sidebarView ? "493px" : 0 }}
    >
      <div className="relative w-[493px] shrink-0">
        <AnimatePresence>
          {sidebarView === "connection-stats" && (
            <motion.div
              className="absolute inset-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{
                duration: 0.5,
                ease: "easeInOut",
              }}
            >
              <ConnectionStatsSidebar />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

KvmIdRoute.loader = loader;
