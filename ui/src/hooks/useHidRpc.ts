import { useCallback, useEffect, useRef } from "react";
import { useRTCStore, useHidStore } from "./stores";
import {
  marshalKeypressReport,
  marshalKeyboardReport,
  marshalKeypressKeepAlive,
  marshalHandshake,
  unmarshalMessage,
  MessageType,
  parseKeyboardLedState,
} from "./hidRpc";

export function useHidRpc() {
  const hidChannel = useRTCStore(state => state.hidChannel);
  const setRpcHidReady = useHidStore(state => state.setRpcHidReady);
  const setKeyboardLedState = useHidStore(state => state.setKeyboardLedState);
  const setKeysDownState = useHidStore(state => state.setKeysDownState);
  const rpcHidReadyRef = useRef(false);

  // Send keypress event
  const reportKeypressEvent = useCallback(
    (key: number, press: boolean) => {
      if (!rpcHidReadyRef.current || !hidChannel || hidChannel.readyState !== "open") {
        return false;
      }
      const data = marshalKeypressReport(key, press);
      hidChannel.send(data);
      return true;
    },
    [hidChannel]
  );

  // Send keyboard report (for legacy compatibility)
  const reportKeyboardEvent = useCallback(
    (modifier: number, keys: number[]) => {
      if (!rpcHidReadyRef.current || !hidChannel || hidChannel.readyState !== "open") {
        return false;
      }
      const data = marshalKeyboardReport(modifier, keys);
      hidChannel.send(data);
      return true;
    },
    [hidChannel]
  );

  // Send keepalive
  const reportKeypressKeepAlive = useCallback(() => {
    if (!rpcHidReadyRef.current || !hidChannel || hidChannel.readyState !== "open") {
      return false;
    }
    const data = marshalKeypressKeepAlive();
    hidChannel.send(data);
    return true;
  }, [hidChannel]);

  // Handle incoming HID-RPC messages
  useEffect(() => {
    if (!hidChannel) return;

    const messageHandler = (event: MessageEvent) => {
      const msg = unmarshalMessage(event.data);

      switch (msg.type) {
        case MessageType.Handshake:
          if (msg.data[0] === 1) {
            rpcHidReadyRef.current = true;
            setRpcHidReady(true);
          }
          break;
        case MessageType.KeyboardLedState:
          setKeyboardLedState(parseKeyboardLedState(msg.data));
          break;
        case MessageType.KeysDownState:
          // Parse modifier + 6 keys
          if (msg.data.length >= 7) {
            setKeysDownState({
              modifier: msg.data[0],
              keys: Array.from(msg.data.slice(1, 7)),
            });
          }
          break;
      }
    };

    hidChannel.addEventListener("message", messageHandler);

    // Send handshake
    if (hidChannel.readyState === "open") {
      hidChannel.send(marshalHandshake(1));
    } else {
      hidChannel.addEventListener("open", () => {
        hidChannel.send(marshalHandshake(1));
      }, { once: true });
    }

    return () => {
      hidChannel.removeEventListener("message", messageHandler);
      rpcHidReadyRef.current = false;
      setRpcHidReady(false);
    };
  }, [hidChannel, setRpcHidReady, setKeyboardLedState, setKeysDownState]);

  return {
    rpcHidReady: rpcHidReadyRef.current,
    reportKeypressEvent,
    reportKeyboardEvent,
    reportKeypressKeepAlive,
  };
}
