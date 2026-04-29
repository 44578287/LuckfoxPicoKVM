export const MessageType = {
  Handshake: 0x01,
  KeyboardReport: 0x02,
  PointerReport: 0x03,
  WheelReport: 0x04,
  KeypressReport: 0x05,
  MouseReport: 0x06,
  KeyboardMacroReport: 0x07,
  CancelKeyboardMacro: 0x08,
  KeypressKeepAlive: 0x09,
  KeyboardLedState: 0x32,
  KeysDownState: 0x33,
  KeyboardMacroState: 0x34,
} as const;

export function marshalKeypressReport(key: number, press: boolean): Uint8Array {
  return new Uint8Array([MessageType.KeypressReport, key, press ? 1 : 0]);
}

export function marshalKeyboardReport(modifier: number, keys: number[]): Uint8Array {
  const data = new Uint8Array(8);
  data[0] = MessageType.KeyboardReport;
  data[1] = modifier;
  for (let i = 0; i < Math.min(keys.length, 6); i++) {
    data[2 + i] = keys[i];
  }
  return data;
}

export function marshalKeypressKeepAlive(): Uint8Array {
  return new Uint8Array([MessageType.KeypressKeepAlive]);
}

export function marshalHandshake(version: number): Uint8Array {
  return new Uint8Array([MessageType.Handshake, version]);
}

export interface HidRpcMessage {
  type: number;
  data: Uint8Array;
}

export function unmarshalMessage(data: ArrayBuffer): HidRpcMessage {
  const view = new Uint8Array(data);
  return {
    type: view[0],
    data: view.slice(1),
  };
}

export interface KeyboardLedState {
  num_lock: boolean;
  caps_lock: boolean;
  scroll_lock: boolean;
  compose: boolean;
  kana: boolean;
  shift: boolean;
}

export function parseKeyboardLedState(data: Uint8Array): KeyboardLedState {
  const raw = data[0] || 0;
  return {
    num_lock: !!(raw & (1 << 0)),
    caps_lock: !!(raw & (1 << 1)),
    scroll_lock: !!(raw & (1 << 2)),
    compose: !!(raw & (1 << 3)),
    kana: !!(raw & (1 << 4)),
    shift: !!(raw & (1 << 6)),
  };
}
