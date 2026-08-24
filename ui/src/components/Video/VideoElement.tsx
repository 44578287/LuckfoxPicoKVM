import { forwardRef, useCallback } from "react";
import { isMobile } from 'react-device-detect';

import { useHidStore, useMouseStore, useSettingsStore } from "@/hooks/stores";
import { useJsonRpc } from "@/hooks/useJsonRpc";

interface VideoElementProps {
  onPlaying: () => void;
  style: React.CSSProperties;
  className: string;
}

export const VideoElement = forwardRef<HTMLVideoElement, VideoElementProps>(
  ({ onPlaying, style, className }, ref) => {
    const setVirtualKeyboardEnabled = useHidStore(state => state.setVirtualKeyboardEnabled);
    const isVirtualKeyboardEnabled = useHidStore(state => state.isVirtualKeyboardEnabled);
    const allowTapToOpenVirtualKeyboard = useHidStore(state => state.allowTapToOpenVirtualKeyboard);
    const mouseMode = useSettingsStore(state => state.mouseMode);
    const mouseX = useMouseStore(state => state.mouseX);
    const mouseY = useMouseStore(state => state.mouseY);
    const [, sendNotification] = useJsonRpc();

    const handleClick = () => {
      if (isMobile && allowTapToOpenVirtualKeyboard && !isVirtualKeyboardEnabled) {
        setVirtualKeyboardEnabled(true);
      }
    };

    // In absolute mode the browser pointer must only control the host while it
    // is over the *rendered picture*. Keep the video element itself at the
    // picture aspect ratio rather than stretching its DOM hit box to 100vw and
    // relying on object-contain letterboxing inside that oversized hit box.
    const mergedStyle = {
      ...style,
      display: 'block',
      maxWidth: '100%',
      maxHeight: '100%',
      minWidth: 0,
      minHeight: 0,
      width: 'auto',
      height: 'auto',
    };

    const releaseRemoteButtons = useCallback(() => {
      if (mouseMode !== "absolute") return;
      // Preserve the last valid host cursor position; only release buttons.
      // Moving to (0,0) on leave/blur is surprising and can trigger UI actions.
      sendNotification("absMouseReport", { x: mouseX, y: mouseY, buttons: 0 });
    }, [mouseMode, mouseX, mouseY, sendNotification]);

    return (
      <video
        ref={ref}
        autoPlay={true}
        controls={false}
        onPlaying={onPlaying}
        onPlay={onPlaying}
        onClick={handleClick}
        onPointerLeave={releaseRemoteButtons}
        muted={true}
        playsInline
        disablePictureInPicture
        controlsList="nofullscreen"
        style={mergedStyle}
        className={className}
      />
    );
  }
);

VideoElement.displayName = "VideoElement";
