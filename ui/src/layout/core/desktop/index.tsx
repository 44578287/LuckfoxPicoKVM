import type { ReactNode } from "react";
import { isMobile } from "react-device-detect";

import MobileDesktop from "@/layout/core/desktop/DesktopMobile";
import PCDesktop from "@/layout/core/desktop/DesktopPC";
import { useTerminal } from "@/layout/components_bottom/terminal/useTerminal";

interface DesktopProps {
  isFullscreen?: number;
  connectionOverlay?: ReactNode;
}

export default function Desktop({ isFullscreen, connectionOverlay }: DesktopProps) {
  useTerminal();
  if (isMobile) {
    return <MobileDesktop isFullscreen={isFullscreen} connectionOverlay={connectionOverlay} />;
  }
  return <PCDesktop isFullscreen={isFullscreen} connectionOverlay={connectionOverlay} />;
}
