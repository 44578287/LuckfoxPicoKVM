import { useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { isMobile } from "react-device-detect";

import { GridCard } from "@components/Card";
import { Button } from "@components/Button";
import LogoLuckfox from "@/assets/logo-luckfox.png";
import { useSettingsStore, useUiStore } from "@/hooks/stores";
import { resumeHttpSessionAfterTakeover, useJsonRpc } from "@/hooks/useJsonRpc";

interface ContextType {
  setupPeerConnection: () => Promise<void>;
}
/* TODO: Migrate to using URLs instead of the global state. To simplify the refactoring, we'll keep the global state for now. */

export default function OtherSessionRoute() {
  const outletContext = useOutletContext<ContextType>();
  const navigate = useNavigate();
  const setOtherSession = useUiStore(state => state.setOtherSession);
  const forceHttp = useSettingsStore(state => state.forceHttp);
  const [send] = useJsonRpc();
  const [takingOver, setTakingOver] = useState(false);

  const handleClose = () => {
    if (takingOver) return;
    setTakingOver(true);

    // The displaced page intentionally suspended automatic HTTP fallback when
    // it received otherSessionConnected. Only an explicit human click here may
    // give this tab a fresh fallback identity and allow it to reclaim control.
    resumeHttpSessionAfterTakeover();

    if (forceHttp) {
      send("confirmOtherSession", {}, resp => {
        if ("error" in resp) {
          setTakingOver(false);
          return;
        }
        if (isMobile) setOtherSession(false);
        navigate("..");
      });
      return;
    }

    if (isMobile) {
      setOtherSession(false);
      setTakingOver(false);
      return;
    }

    // setupPeerConnection itself creates the new exclusive WebRTC session. Do
    // not issue a separate HTTP ownership request in normal WebRTC mode.
    outletContext?.setupPeerConnection()
      .then(() => navigate(".."))
      .catch(() => setTakingOver(false));
  };

  return (
    <GridCard cardClassName="relative mx-auto max-w-md text-left pointer-events-auto z-[10000] !pointer-events-auto">
      <div className="p-10">
        <div className="flex min-h-[140px] flex-col items-start justify-start space-y-4 text-left">
          <div className="h-[24px]">
            <img src={LogoLuckfox} alt="" className="h-full dark:hidden" />
            <img src={LogoLuckfox} alt="" className="hidden h-full dark:block" />
          </div>

          <div className="text-left">
            <p className="text-base font-semibold dark:text-white">
              Another Active Session Detected
            </p>
            <p className="mb-4 text-sm text-slate-600 dark:text-[#ffffff]">
              Only one active session is supported at a time. Would you like to take over
              this session?
            </p>
            <div className="flex items-center justify-start space-x-4">
              <Button
                size="SM"
                theme="primary"
                text={takingOver ? "Taking Over..." : "Use Here"}
                loading={takingOver}
                onClick={handleClose}
              />
            </div>
          </div>
        </div>
      </div>
    </GridCard>
  );
}
