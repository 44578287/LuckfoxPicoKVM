import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useResizeObserver } from "usehooks-ts";

import VirtualKeyboard from "@components/VirtualKeyboard";
import Actionbar from "@components/ActionBar";
import MacroBar from "@/components/MacroBar";
import InfoBar from "@components/InfoBar";
import notifications from "@/notifications";
import useKeyboard from "@/hooks/useKeyboard";
import { useJsonRpc } from "@/hooks/useJsonRpc";
import { cx } from "@/cva.config";
import { keys, modifiers } from "@/keyboardMappings";
import { chars } from "@/keyboardLayouts";
import {
  useHidStore,
  useMouseStore,
  useRTCStore,
  useSettingsStore,
  useVideoStore,
} from "@/hooks/stores";

import {
  HDMIErrorOverlay,
  LoadingVideoOverlay,
  NoAutoplayPermissionsOverlay,
  PointerLockBar,
} from "./VideoOverlay";


export default function WebRTCVideo() {
  // Video and stream related refs and states
  const videoElm = useRef<HTMLVideoElement>(null);
  const audioElm = useRef<HTMLAudioElement>(null);
  const pasteCaptureRef = useRef<HTMLTextAreaElement>(null);
  const mediaStream = useRTCStore(state => state.mediaStream);
  const [isPlaying, setIsPlaying] = useState(false);
  const peerConnectionState = useRTCStore(state => state.peerConnectionState);
  const [isPointerLockActive, setIsPointerLockActive] = useState(false);
  const [mobileScale, setMobileScale] = useState(1);
  const [mobileTx, setMobileTx] = useState(0);
  const [mobileTy, setMobileTy] = useState(0);
  const activeTouchPointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const initialPinchDistance = useRef<number | null>(null);
  const initialPinchScale = useRef<number>(1);
  const lastPanPoint = useRef<{ x: number; y: number } | null>(null);
  const lastTapAt = useRef<number>(0);
  // Store hooks
  const settings = useSettingsStore();
  const { sendKeyboardEvent, resetKeyboardState } = useKeyboard();
  const setMousePosition = useMouseStore(state => state.setMousePosition);
  const setMouseMove = useMouseStore(state => state.setMouseMove);
  const isReinitializingGadget = useHidStore(state => state.isReinitializingGadget);
  const {
    setClientSize: setVideoClientSize,
    setSize: setVideoSize,
    width: videoWidth,
    height: videoHeight,
    clientWidth: videoClientWidth,
    clientHeight: videoClientHeight,
  } = useVideoStore();

  // Video enhancement settings
  const videoSaturation = useSettingsStore(state => state.videoSaturation);
  const videoBrightness = useSettingsStore(state => state.videoBrightness);
  const videoContrast = useSettingsStore(state => state.videoContrast);

  // HID related states
  const keyboardLedStateSyncAvailable = useHidStore(state => state.keyboardLedStateSyncAvailable);
  const keyboardLedSync = useSettingsStore(state => state.keyboardLedSync);
  const isKeyboardLedManagedByHost = useMemo(() =>
    keyboardLedSync !== "browser" && keyboardLedStateSyncAvailable,
    [keyboardLedSync, keyboardLedStateSyncAvailable],
  );

  const setIsNumLockActive = useHidStore(state => state.setIsNumLockActive);
  const setIsCapsLockActive = useHidStore(state => state.setIsCapsLockActive);
  const setIsScrollLockActive = useHidStore(state => state.setIsScrollLockActive);

  // RTC related states
  const peerConnection = useRTCStore(state => state.peerConnection);

  // HDMI and UI states
  const hdmiState = useVideoStore(state => state.hdmiState);
  const hdmiError = ["no_lock", "no_signal", "out_of_range"].includes(hdmiState);
  const isVideoLoading = !isPlaying;

  const [blockWheelEvent, setBlockWheelEvent] = useState(false);

  // Misc states and hooks
  const [send] = useJsonRpc();

  const overrideCtrlV = useSettingsStore(state => state.overrideCtrlV);
  const keyboardLayout = useSettingsStore(state => state.keyboardLayout);
  const safeKeyboardLayout = useMemo(() => {
    if (keyboardLayout && keyboardLayout.length > 0) return keyboardLayout;
    return "en_US";
  }, [keyboardLayout]);

  const sendTextViaHID = useCallback(async (t: string) => {
    for (const ch of t) {
      const mapping = chars[safeKeyboardLayout][ch];
      if (!mapping || !mapping.key) continue;
      const { key, shift, altRight, deadKey, accentKey } = mapping;
      const keyz = [keys[key]];
      const modz = [(shift ? modifiers["ShiftLeft"] : 0) | (altRight ? modifiers["AltRight"] : 0)];
      if (deadKey) {
        keyz.push(keys["Space"]);
        modz.push(0);
      }
      if (accentKey) {
        keyz.unshift(keys[accentKey.key as keyof typeof keys]);
        modz.unshift(((accentKey.shift ? modifiers["ShiftLeft"] : 0) | (accentKey.altRight ? modifiers["AltRight"] : 0)));
      }
      for (const [index, kei] of keyz.entries()) {
        await new Promise<void>((resolve, reject) => {
          send("keyboardReport", { keys: [kei], modifier: modz[index] }, params => {
            if ("error" in params) return reject(params.error as unknown as Error);
            send("keyboardReport", { keys: [], modifier: 0 }, params => {
              if ("error" in params) return reject(params.error as unknown as Error);
              resolve();
            });
          });
        });
      }
    }
  }, [send, safeKeyboardLayout]);

  const handleGlobalPaste = useCallback(async (e: ClipboardEvent) => {
    if (!overrideCtrlV) return;
    e.preventDefault();
    const txt = e.clipboardData?.getData("text") || "";
    if (!txt) return;
    const invalid = [
      ...new Set(
        // @ts-expect-error
        [...new Intl.Segmenter().segment(txt)].map(x => x.segment).filter(ch => !chars[safeKeyboardLayout][ch]),
      ),
    ];
    if (invalid.length > 0) {
      notifications.error(`Invalid characters: ${invalid.join(", ")}`);
      return;
    }
    if (isReinitializingGadget) return;
    try {
      await sendTextViaHID(txt);
      notifications.success(`Pasted: "${txt}"`);
    } catch {
      notifications.error("Failed to paste text");
    }
  }, [overrideCtrlV, safeKeyboardLayout, isReinitializingGadget, sendTextViaHID]);

  // Video-related
  useResizeObserver({
    ref: videoElm as React.RefObject<HTMLElement>,
    onResize: ({ width, height }) => {
      // This is actually client size, not videoSize
      if (width && height) {
        if (!videoElm.current) return;
        setVideoClientSize(width, height);
        setVideoSize(videoElm.current.videoWidth, videoElm.current.videoHeight);
      }
    },
  });

  const updateVideoSizeStore = useCallback(
    (videoElm: HTMLVideoElement) => {
      setVideoClientSize(videoElm.clientWidth, videoElm.clientHeight);
      setVideoSize(videoElm.videoWidth, videoElm.videoHeight);
    },
    [setVideoClientSize, setVideoSize],
  );

  const onVideoPlaying = useCallback(() => {
    setIsPlaying(true);
    if (videoElm.current) updateVideoSizeStore(videoElm.current);
  }, [updateVideoSizeStore]);

  // On mount, get the video size
  useEffect(
    function updateVideoSizeOnMount() {
      if (videoElm.current) updateVideoSizeStore(videoElm.current);
    },
    [setVideoClientSize, updateVideoSizeStore, setVideoSize],
  );

  // Pointer lock and keyboard lock related
  const isPointerLockPossible = window.location.protocol === "https:" || window.location.hostname === "localhost";
  const isFullscreenEnabled = document.fullscreenEnabled;
 
  const checkNavigatorPermissions = useCallback(async (permissionName: string) => {
    if (!navigator.permissions || !navigator.permissions.query) {
      return false; // if can't query permissions, assume NOT granted
    }

    try {
      const name = permissionName as PermissionName;
      const { state } = await navigator.permissions.query({ name });
      return state === "granted";
    } catch {
      // ignore errors
    }
    return false; // if query fails, assume NOT granted
  }, []);

  const requestPointerLock = useCallback(async () => {
    if (!isPointerLockPossible
      || videoElm.current === null
      || document.pointerLockElement) return;

    const isPointerLockGranted = await checkNavigatorPermissions("pointer-lock");

    if (isPointerLockGranted && settings.mouseMode === "relative") {
      try {
        await videoElm.current.requestPointerLock();
      } catch {
        // ignore errors
      }
    }
  }, [checkNavigatorPermissions, isPointerLockPossible, settings.mouseMode]);

  const requestKeyboardLock = useCallback(async () => {
    if (videoElm.current === null) return;

    const isKeyboardLockGranted = await checkNavigatorPermissions("keyboard-lock");
  
    if (isKeyboardLockGranted && "keyboard" in navigator) {
      try {
        // @ts-expect-error - keyboard lock is not supported in all browsers
         await navigator.keyboard.lock();
      } catch {
        // ignore errors
      }
    }
  }, [checkNavigatorPermissions]);

  const releaseKeyboardLock = useCallback(async () => {
    if (videoElm.current === null || document.fullscreenElement !== videoElm.current) return;

    if ("keyboard" in navigator) {
        try {
          // @ts-expect-error - keyboard unlock is not supported in all browsers
          await navigator.keyboard.unlock();
        } catch {
          // ignore errors
       }
    }
  }, []);

  useEffect(() => {
    if (!isPointerLockPossible || !videoElm.current) return;

    const handlePointerLockChange = () => {
      if (document.pointerLockElement) {
        notifications.success("Pointer lock Enabled, press escape to unlock");
        setIsPointerLockActive(true);
      } else {
        notifications.success("Pointer lock Disabled");
        setIsPointerLockActive(false);
      }
    };

    const abortController = new AbortController();
    const signal = abortController.signal;

    document.addEventListener("pointerlockchange", handlePointerLockChange, { signal });

    return () => {
      abortController.abort();
    };
  }, [isPointerLockPossible]);

  const requestFullscreen = useCallback(async () => {
     if (!isFullscreenEnabled || !videoElm.current) return;

    // per https://wicg.github.io/keyboard-lock/#system-key-press-handler
    // If keyboard lock is activated after fullscreen is already in effect, then the user my 
    // see multiple messages about how to exit fullscreen. For this reason, we recommend that
    // developers call lock() before they enter fullscreen:
    await requestKeyboardLock();
    await requestPointerLock();

    await videoElm.current.requestFullscreen({
      navigationUI: "show",
    });
  }, [isFullscreenEnabled, requestKeyboardLock, requestPointerLock]);

  // setup to release the keyboard lock anytime the fullscreen ends
  useEffect(() => {
    if (!videoElm.current) return;

    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) {
        releaseKeyboardLock();
      }
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
  }, [releaseKeyboardLock]);

  // Mouse-related
  const calcDelta = (pos: number) => (Math.abs(pos) < 10 ? pos * 2 : pos);

  const sendRelMouseMovement = useCallback(
    (x: number, y: number, buttons: number) => {
      if (settings.mouseMode !== "relative") return;
      // Don't send mouse events while reinitializing gadget
      if (isReinitializingGadget) return;
      // if we ignore the event, double-click will not work
      // if (x === 0 && y === 0 && buttons === 0) return;
      send("relMouseReport", { dx: calcDelta(x), dy: calcDelta(y), buttons });
      setMouseMove({ x, y, buttons });
    },
    [send, setMouseMove, settings.mouseMode, isReinitializingGadget],
  );

  const relMouseMoveHandler = useCallback(
    (e: MouseEvent) => {
      const pt = (e as unknown as PointerEvent).pointerType as unknown as string;
      if (pt === "touch") {
        const touchCount = activeTouchPointers.current.size;
        if (touchCount >= 2) return;
        if (mobileScale > 1 && lastPanPoint.current) return;
      }
      if (settings.mouseMode !== "relative") return;
      if (isPointerLockActive === false && isPointerLockPossible) return;

      // Send mouse movement
      const { buttons } = e;
      sendRelMouseMovement(e.movementX, e.movementY, buttons);
    },
    [isPointerLockActive, isPointerLockPossible, sendRelMouseMovement, settings.mouseMode],
  );

  const sendAbsMouseMovement = useCallback(
    (x: number, y: number, buttons: number) => {
      if (settings.mouseMode !== "absolute") return;
      // Don't send mouse events while reinitializing gadget
      if (isReinitializingGadget) return;
      send("absMouseReport", { x, y, buttons });
      // We set that for the debug info bar
      setMousePosition(x, y);
    },
    [send, setMousePosition, settings.mouseMode, isReinitializingGadget],
  );

  const absMouseMoveHandler = useCallback(
    (e: MouseEvent) => {
      const pt = (e as unknown as PointerEvent).pointerType as unknown as string;
      if (pt === "touch") {
        const touchCount = activeTouchPointers.current.size;
        if (touchCount >= 2) return;
        if (mobileScale > 1) {
          return;
        }
      }
      if (!videoClientWidth || !videoClientHeight) return;
      if (settings.mouseMode !== "absolute") return;

      // Get the aspect ratios of the video element and the video stream
      const videoElementAspectRatio = videoClientWidth / videoClientHeight;
      const videoStreamAspectRatio = videoWidth / videoHeight;

      // Calculate the effective video display area
      let effectiveWidth = videoClientWidth;
      let effectiveHeight = videoClientHeight;
      let offsetX = 0;
      let offsetY = 0;

      if (videoElementAspectRatio > videoStreamAspectRatio) {
        // Pillarboxing: black bars on the left and right
        effectiveWidth = videoClientHeight * videoStreamAspectRatio;
        offsetX = (videoClientWidth - effectiveWidth) / 2;
      } else if (videoElementAspectRatio < videoStreamAspectRatio) {
        // Letterboxing: black bars on the top and bottom
        effectiveHeight = videoClientWidth / videoStreamAspectRatio;
        offsetY = (videoClientHeight - effectiveHeight) / 2;
      }

      // Determine input point (reverse transform for touch when zoomed)
      const inputOffsetX = pt === "touch" ? Math.max(0, Math.min(videoClientWidth, (e.offsetX - mobileTx) / mobileScale)) : e.offsetX;
      const inputOffsetY = pt === "touch" ? Math.max(0, Math.min(videoClientHeight, (e.offsetY - mobileTy) / mobileScale)) : e.offsetY;

      // Clamp mouse position within the effective video boundaries
      const clampedX = Math.min(Math.max(offsetX, inputOffsetX), offsetX + effectiveWidth);
      const clampedY = Math.min(Math.max(offsetY, inputOffsetY), offsetY + effectiveHeight);

      // Map clamped mouse position to the video stream's coordinate system
      const relativeX = (clampedX - offsetX) / effectiveWidth;
      const relativeY = (clampedY - offsetY) / effectiveHeight;

      // Convert to HID absolute coordinate system (0-32767 range)
      const x = Math.round(relativeX * 32767);
      const y = Math.round(relativeY * 32767);

      // Send mouse movement
      const { buttons } = e;
      sendAbsMouseMovement(x, y, buttons);
    },
    [settings.mouseMode, videoClientWidth, videoClientHeight, videoWidth, videoHeight, sendAbsMouseMovement, mobileScale, mobileTx, mobileTy],
  );

  const mouseWheelHandler = useCallback(
    (e: WheelEvent) => {
      // Don't send wheel events while reinitializing gadget
      if (isReinitializingGadget) return;

      if (settings.scrollThrottling && blockWheelEvent) {
        return;
      }

      // Determine if the wheel event is an accel scroll value
      const isAccel = Math.abs(e.deltaY) >= 100;

      // Calculate the accel scroll value
      const accelScrollValue = e.deltaY / 100;

      // Calculate the no accel scroll value
      const noAccelScrollValue = Math.sign(e.deltaY);

      // Get scroll value
      const scrollValue = isAccel ? accelScrollValue : noAccelScrollValue;

      // Apply clamping (i.e. min and max mouse wheel hardware value)
      const clampedScrollValue = Math.max(-127, Math.min(127, scrollValue));

      // Invert the clamped scroll value to match expected behavior
      const invertedScrollValue = -clampedScrollValue;

      send("wheelReport", { wheelY: invertedScrollValue });

      // Apply blocking delay based of throttling settings
      if (settings.scrollThrottling && !blockWheelEvent) {
        setBlockWheelEvent(true);
        setTimeout(() => setBlockWheelEvent(false), settings.scrollThrottling);
      }
    },
    [send, blockWheelEvent, settings, isReinitializingGadget],
  );

  const resetMousePosition = useCallback(() => {
    sendAbsMouseMovement(0, 0, 0);
  }, [sendAbsMouseMovement]);

  // Keyboard-related
  const handleModifierKeys = useCallback(
    (e: KeyboardEvent, activeModifiers: number[]) => {
      const { shiftKey, ctrlKey, altKey, metaKey } = e;

      const filteredModifiers = activeModifiers.filter(Boolean);

      // Example: activeModifiers = [0x01, 0x02, 0x04, 0x08]
      // Assuming 0x01 = ControlLeft, 0x02 = ShiftLeft, 0x04 = AltLeft, 0x08 = MetaLeft
      return (
        filteredModifiers
          // Shift: Keep if Shift is pressed or if the key isn't a Shift key
          // Example: If shiftKey is true, keep all modifiers
          // If shiftKey is false, filter out 0x02 (ShiftLeft) and 0x20 (ShiftRight)
          .filter(
            modifier =>
              shiftKey ||
              (modifier !== modifiers["ShiftLeft"] &&
                modifier !== modifiers["ShiftRight"]),
          )
          // Ctrl: Keep if Ctrl is pressed or if the key isn't a Ctrl key
          // Example: If ctrlKey is true, keep all modifiers
          // If ctrlKey is false, filter out 0x01 (ControlLeft) and 0x10 (ControlRight)
          .filter(
            modifier =>
              ctrlKey ||
              (modifier !== modifiers["ControlLeft"] &&
                modifier !== modifiers["ControlRight"]),
          )
          // Alt: Keep if Alt is pressed or if the key isn't an Alt key
          // Example: If altKey is true, keep all modifiers
          // If altKey is false, filter out 0x04 (AltLeft)
          //
          // But intentionally do not filter out 0x40 (AltRight) to accomodate
          // Alt Gr (Alt Graph) as a modifier. Oddly, Alt Gr does not declare
          // itself to be an altKey. For example, the KeyboardEvent for
          // Alt Gr + 2 has the following structure:
          // - altKey: false
          // - code:   "Digit2"
          // - type:   [ "keydown" | "keyup" ]
          //
          // For context, filteredModifiers aims to keep track which modifiers
          // are being pressed on the physical keyboard at any point in time.
          // There is logic in the keyUpHandler and keyDownHandler to add and
          // remove 0x40 (AltRight) from the list of new modifiers.
          //
          // But relying on the two handlers alone to track the state of the
          // modifier bears the risk that the key up event for Alt Gr could
          // get lost while the browser window is temporarily out of focus,
          // which means the Alt Gr key state would then be "stuck". At this
          // point, we would need to rely on the user to press Alt Gr again
          // to properly release the state of that modifier.
          .filter(modifier => altKey || modifier !== modifiers["AltLeft"])
          // Meta: Keep if Meta is pressed or if the key isn't a Meta key
          // Example: If metaKey is true, keep all modifiers
          // If metaKey is false, filter out 0x08 (MetaLeft) and 0x80 (MetaRight)
          .filter(
            modifier =>
              metaKey ||
              (modifier !== modifiers["MetaLeft"] && modifier !== modifiers["MetaRight"]),
          )
      );
    },
    [],
  );

  const keyDownHandler = useCallback(
    async (e: KeyboardEvent) => {
      if (overrideCtrlV && (e.code === "KeyV" || e.key.toLowerCase() === "v") && (e.ctrlKey || e.metaKey)) {
        console.log("Override Ctrl V");
        if (isReinitializingGadget) return;
        if (pasteCaptureRef.current) {
          pasteCaptureRef.current.value = "";
          pasteCaptureRef.current.focus();
        }
        return;
      }
      
      e.preventDefault();
      const prev = useHidStore.getState();
      let code = e.code;
      const key = e.key;

      if (!isKeyboardLedManagedByHost) {
        setIsNumLockActive(e.getModifierState("NumLock"));
        setIsCapsLockActive(e.getModifierState("CapsLock"));
        setIsScrollLockActive(e.getModifierState("ScrollLock"));
      }

      if (code == "IntlBackslash" && ["`", "~"].includes(key)) {
        code = "Backquote";
      } else if (code == "Backquote" && ["§", "±"].includes(key)) {
        code = "IntlBackslash";
      }

      // Add the key to the active keys
      const newKeys = [...prev.activeKeys, keys[code]].filter(Boolean);

      // Add the modifier to the active modifiers
      const newModifiers = handleModifierKeys(e, [
        ...prev.activeModifiers,
        modifiers[code],
      ]);

      // When pressing the meta key + another key, the key will never trigger a keyup
      // event, so we need to clear the keys after a short delay
      // https://bugs.chromium.org/p/chromium/issues/detail?id=28089
      // https://bugzilla.mozilla.org/show_bug.cgi?id=1299553
      if (e.metaKey) {
        setTimeout(() => {
          const prev = useHidStore.getState();
          sendKeyboardEvent([], newModifiers || prev.activeModifiers);
        }, 10);
      }

      sendKeyboardEvent([...new Set(newKeys)], [...new Set(newModifiers)]);
    },
    [
      handleModifierKeys,
      sendKeyboardEvent,
      send,
      isKeyboardLedManagedByHost,
      setIsNumLockActive,
      setIsCapsLockActive,
      setIsScrollLockActive,
      overrideCtrlV,
      pasteCaptureRef,
      safeKeyboardLayout,
      isReinitializingGadget,
    ],
  );

  const keyUpHandler = useCallback(
    (e: KeyboardEvent) => {
      e.preventDefault();
      const prev = useHidStore.getState();

      if (!isKeyboardLedManagedByHost) {
        setIsNumLockActive(e.getModifierState("NumLock"));
        setIsCapsLockActive(e.getModifierState("CapsLock"));
        setIsScrollLockActive(e.getModifierState("ScrollLock"));
      }

      // Filtering out the key that was just released (keys[e.code])
      const newKeys = prev.activeKeys.filter(k => k !== keys[e.code]).filter(Boolean);

      // Filter out the modifier that was just released
      const newModifiers = handleModifierKeys(
        e,
        prev.activeModifiers.filter(k => k !== modifiers[e.code]),
      );

      sendKeyboardEvent([...new Set(newKeys)], [...new Set(newModifiers)]);
    },
    [
      handleModifierKeys,
      sendKeyboardEvent,
      isKeyboardLedManagedByHost,
      setIsNumLockActive,
      setIsCapsLockActive,
      setIsScrollLockActive,
    ],
  );

  const videoKeyUpHandler = useCallback((e: KeyboardEvent) => {
    if (!videoElm.current) return;

    // In fullscreen mode in chrome & safari, the space key is used to pause/play the video
    // there is no way to prevent this, so we need to simply force play the video when it's paused.
    // Fix only works in chrome based browsers.
    if (e.code === "Space") {
      if (videoElm.current.paused) {
        console.log("Force playing video");
        videoElm.current.play();
      }
    }
  }, []);

  const addStreamToVideoElm = useCallback(
    (mediaStream: MediaStream) => {
      if (!videoElm.current) return;
      const videoElmRefValue = videoElm.current;
      videoElmRefValue.srcObject = mediaStream;
      updateVideoSizeStore(videoElmRefValue);
    },
    [updateVideoSizeStore],
  );

  const addStreamToAudioElm = useCallback(
    (mediaStream: MediaStream) => {
      if (!audioElm.current) return;
      const audioElmRefValue = audioElm.current;
      audioElmRefValue.srcObject = mediaStream;
      //audioElm.current.play();
    },
    [],
  );
   
  useEffect(
    function updateVideoStreamOnNewTrack() {
      if (!peerConnection) return;
      const abortController = new AbortController();
      const signal = abortController.signal;

      peerConnection.addEventListener(
        "track",
        (e: RTCTrackEvent) => {
          addStreamToVideoElm(e.streams[0]);
        },
        { signal },
      );

      return () => {
        abortController.abort();
      };
    },
    [addStreamToVideoElm, peerConnection],
  );

  useEffect(
    function updateVideoStream() {
      if (!mediaStream) return;
      // We set the as early as possible
      addStreamToVideoElm(mediaStream);
      addStreamToAudioElm(mediaStream);
    },
    [
      setVideoClientSize,
      mediaStream,
      updateVideoSizeStore,
      peerConnection,
      addStreamToVideoElm,
      addStreamToAudioElm,
    ],
  );

  // Setup Keyboard Events
  useEffect(function setupKeyboardEvents() {
    const abortController = new AbortController();
    const signal = abortController.signal;

    document.addEventListener("keydown", keyDownHandler, { signal });
    document.addEventListener("keyup", keyUpHandler, { signal });

    window.addEventListener("blur", resetKeyboardState, { signal });
    document.addEventListener("visibilitychange", resetKeyboardState, { signal });

    return () => {
      abortController.abort();
    };
  }, [keyDownHandler, keyUpHandler, resetKeyboardState]);

  // Setup Video Event Listeners
  useEffect(
    function setupVideoEventListeners() {
      const videoElmRefValue = videoElm.current;
      if (!videoElmRefValue) return;

      const abortController = new AbortController();
      const signal = abortController.signal;

      // To prevent the video from being paused when the user presses a space in fullscreen mode
      videoElmRefValue.addEventListener("keyup", videoKeyUpHandler, { signal });

      // We need to know when the video is playing to update state and video size
      videoElmRefValue.addEventListener("playing", onVideoPlaying, { signal });

      return () => {
        abortController.abort();
      };
    },
    [onVideoPlaying, videoKeyUpHandler],
  );

  // Setup Global Paste Listener (register after handleGlobalPaste is defined)
  useEffect(function setupPasteListener() {
    const abortController = new AbortController();
    const signal = abortController.signal;
    document.addEventListener("paste", handleGlobalPaste, { signal });
    return () => abortController.abort();
  }, [handleGlobalPaste]);

  // Setup Mouse Events
  useEffect(
    function setMouseModeEventListeners() {
      const videoElmRefValue = videoElm.current;
      if (!videoElmRefValue) return;
      const isRelativeMouseMode = (settings.mouseMode === "relative");

      const abortController = new AbortController();
      const signal = abortController.signal;

      videoElmRefValue.addEventListener("mousemove", isRelativeMouseMode ? relMouseMoveHandler : absMouseMoveHandler, { signal });
      videoElmRefValue.addEventListener("pointerdown", isRelativeMouseMode ? relMouseMoveHandler : absMouseMoveHandler, { signal });
      videoElmRefValue.addEventListener("pointerup", isRelativeMouseMode ? relMouseMoveHandler :absMouseMoveHandler, { signal });
      videoElmRefValue.addEventListener("wheel", mouseWheelHandler, {
        signal,
        passive: true,
      });

      if (isRelativeMouseMode) {
        videoElmRefValue.addEventListener("click",
          () => {
            if (isPointerLockPossible && !isPointerLockActive && !document.pointerLockElement) {
              requestPointerLock();
            }
          },
          { signal },
        );
      } else {
        // Reset the mouse position when the window is blurred or the document is hidden
        window.addEventListener("blur", resetMousePosition, { signal });
        document.addEventListener("visibilitychange", resetMousePosition, { signal });
      }

      const preventContextMenu = (e: MouseEvent) => e.preventDefault();
      videoElmRefValue.addEventListener("contextmenu", preventContextMenu, { signal });

      return () => {
        abortController.abort();
      };
    },
    [absMouseMoveHandler, isPointerLockActive, isPointerLockPossible, mouseWheelHandler, relMouseMoveHandler, requestPointerLock, resetMousePosition, settings.mouseMode],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const zoomLayerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = zoomLayerRef.current;
    if (!el) return;
    const abortController = new AbortController();
    const signal = abortController.signal;

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      try { el.setPointerCapture(e.pointerId); } catch {}
      activeTouchPointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activeTouchPointers.current.size === 1) {
        const now = Date.now();
        if (now - lastTapAt.current < 300) {
          setMobileScale(1);
          setMobileTx(0);
          setMobileTy(0);
        }
        lastTapAt.current = now;
        lastPanPoint.current = { x: e.clientX, y: e.clientY };
      } else if (activeTouchPointers.current.size === 2) {
        const pts = Array.from(activeTouchPointers.current.values());
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        initialPinchDistance.current = d;
        initialPinchScale.current = mobileScale;
      }
      e.preventDefault();
      e.stopPropagation();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      const prev = activeTouchPointers.current.get(e.pointerId);
      activeTouchPointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts = Array.from(activeTouchPointers.current.values());
      if (pts.length === 2 && initialPinchDistance.current) {
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const factor = d / initialPinchDistance.current;
        const next = Math.max(1, Math.min(4, initialPinchScale.current * factor));
        setMobileScale(next);
      } else if (pts.length === 1 && lastPanPoint.current && prev) {
        const dx = e.clientX - lastPanPoint.current.x;
        const dy = e.clientY - lastPanPoint.current.y;
        lastPanPoint.current = { x: e.clientX, y: e.clientY };
        setMobileTx(v => v + dx);
        setMobileTy(v => v + dy);
      }
      e.preventDefault();
      e.stopPropagation();
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      activeTouchPointers.current.delete(e.pointerId);
      if (activeTouchPointers.current.size < 2) {
        initialPinchDistance.current = null;
      }
      if (activeTouchPointers.current.size === 0) {
        lastPanPoint.current = null;
      }
      e.preventDefault();
      e.stopPropagation();
    };

    el.addEventListener("pointerdown", onPointerDown, { signal });
    el.addEventListener("pointermove", onPointerMove, { signal });
    el.addEventListener("pointerup", onPointerUp, { signal });
    el.addEventListener("pointercancel", onPointerUp, { signal });

    return () => abortController.abort();
  }, [mobileScale]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (!cw || !ch) return;
    const maxX = (cw * (mobileScale - 1)) / 2;
    const maxY = (ch * (mobileScale - 1)) / 2;
    setMobileTx(x => Math.max(-maxX, Math.min(maxX, x)));
    setMobileTy(y => Math.max(-maxY, Math.min(maxY, y)));
  }, [mobileScale]);

  const hasNoAutoPlayPermissions = useMemo(() => {
    if (peerConnection?.connectionState !== "connected") return false;
    if (isPlaying) return false;
    if (hdmiError) return false;
    if (videoHeight === 0 || videoWidth === 0) return false;
    return true;
  }, [hdmiError, isPlaying, peerConnection?.connectionState, videoHeight, videoWidth]);

  const showPointerLockBar = useMemo(() => {
    if (settings.mouseMode !== "relative") return false;
    if (!isPointerLockPossible) return false;
    if (isPointerLockActive) return false;
    if (isVideoLoading) return false;
    if (!isPlaying) return false;
    if (videoHeight === 0 || videoWidth === 0) return false;
    return true;
  }, [isPlaying, isPointerLockActive, isPointerLockPossible, isVideoLoading, settings.mouseMode, videoHeight, videoWidth]);

  return (
    <div className="grid h-full w-full grid-rows-(--grid-layout)">
      <div className="flex min-h-[39.5px] flex-col">
        <div className="flex flex-col">
          <fieldset
            disabled={peerConnection?.connectionState !== "connected"}
            className="contents"
          >
            <Actionbar requestFullscreen={requestFullscreen} />
            <MacroBar />
          </fieldset>
        </div>
      </div>

      <audio 
        id="global-audio"
        ref={audioElm}
        autoPlay
        muted={true}
        controls={false}
      />

      <div ref={containerRef} className="h-full overflow-hidden">
        <div className="relative h-full">
          <div
            className={cx(
              "absolute inset-0 -z-0 bg-blue-50/40 opacity-80 dark:bg-slate-800/40",
              "bg-[radial-gradient(var(--color-blue-300)_0.5px,transparent_0.5px),radial-gradient(var(--color-blue-300)_0.5px,transparent_0.5px)] dark:bg-[radial-gradient(var(--color-slate-700)_0.5px,transparent_0.5px),radial-gradient(var(--color-slate-700)_0.5px,transparent_0.5px)]",
              "bg-position-[0_0,10px_10px]",
              "bg-size-[20px_20px]",
            )}
          />
          <div className="flex h-full flex-col">
            <div className="relative grow overflow-hidden">
              <div className="flex h-full flex-col">
                <div className="grid grow grid-rows-(--grid-bodyFooter) overflow-hidden">
                  {/* In relative mouse mode and under https, we enable the pointer lock, and to do so we need a bar to show the user to click on the video to enable mouse control */}
                  <PointerLockBar show={showPointerLockBar} />
                  <div className="relative mx-4 my-2 flex items-center justify-center overflow-hidden">
                    <div
                      ref={zoomLayerRef}
                      className="relative flex h-full w-full items-center justify-center"
                      style={{
                        transform: `translate(${mobileTx}px, ${mobileTy}px) scale(${mobileScale})`,
                        transformOrigin: "center center",
                        touchAction: "none",
                      }}
                    >
                        <video
                          ref={videoElm}
                          autoPlay={true}
                          controls={false}
                          onPlaying={onVideoPlaying}
                          onPlay={onVideoPlaying}
                          muted={true}
                          playsInline
                          disablePictureInPicture
                          controlsList="nofullscreen"
                          style={{
                            filter: `saturate(${videoSaturation}) brightness(${videoBrightness}) contrast(${videoContrast})`,
                          }}
                          className={cx(
                            "max-h-full min-h-[384px] max-w-full min-w-[512px] bg-black/50 object-contain transition-all duration-1000",
                            {
                              "cursor-none": settings.isCursorHidden,
                              "opacity-0":
                                isVideoLoading ||
                                hdmiError ||
                                peerConnectionState !== "connected",
                              "opacity-60!": showPointerLockBar,
                              "animate-slideUpFade border border-slate-800/30 shadow-xs dark:border-slate-300/20":
                                isPlaying,
                            },
                          )}
                        />
                        {peerConnection?.connectionState == "connected" && (
                          <div
                            style={{ animationDuration: "500ms" }}
                            className="animate-slideUpFade pointer-events-none absolute inset-0 flex items-center justify-center"
                          >
                            <div className="relative h-full w-full rounded-md">
                              <LoadingVideoOverlay show={isVideoLoading} />
                              <HDMIErrorOverlay show={hdmiError} hdmiState={hdmiState} />
                              <NoAutoplayPermissionsOverlay
                                show={hasNoAutoPlayPermissions}
                                onPlayClick={() => {
                                  videoElm.current?.play();
                                }}
                              />
                            </div>
                          </div>
                        )}
                    </div>
                  </div>
                  <VirtualKeyboard />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div>
        <InfoBar />
      </div>
      <textarea
        ref={pasteCaptureRef}
        aria-hidden="true"
        style={{ position: "fixed", left: -9999, top: -9999, width: 1, height: 1, opacity: 0 }}
        onPaste={async e => {
          console.log("Paste event");
          if (!overrideCtrlV) return;
          e.preventDefault();
          const txt = e.clipboardData?.getData("text") || e.currentTarget.value || "";
          e.currentTarget.blur();
          if (txt) {
            const invalid = [
              ...new Set(
                // @ts-expect-error
                [...new Intl.Segmenter().segment(txt)].map(x => x.segment).filter(ch => !chars[safeKeyboardLayout][ch]),
              ),
            ];
            if (invalid.length > 0) {
              notifications.error(`Invalid characters: ${invalid.join(", ")}`);
              return;
            }
            if (isReinitializingGadget) return;
            try {
              await sendTextViaHID(txt);
              notifications.success(`Pasted: "${txt}"`);
            } catch {
              notifications.error("Failed to paste text");
            }
          }
        }}
      />
    </div>
  );
}
