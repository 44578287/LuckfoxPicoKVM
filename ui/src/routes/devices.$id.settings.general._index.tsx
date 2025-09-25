
import { useState , useEffect } from "react";

import { useJsonRpc } from "@/hooks/useJsonRpc";

import { SettingsPageHeader } from "../components/SettingsPageheader";
import { Button } from "../components/Button";
import notifications from "../notifications";
import Checkbox from "../components/Checkbox";
import { useDeviceUiNavigation } from "../hooks/useAppNavigation";
import { useDeviceStore } from "../hooks/stores";

import { SettingsItem } from "./devices.$id.settings";
import {useReactAt} from 'i18n-auto-extractor/react'

export default function SettingsGeneralRoute() {
  const [send] = useJsonRpc();
  const { navigateTo } = useDeviceUiNavigation();
  const [autoUpdate, setAutoUpdate] = useState(true);
  const { $at } = useReactAt();

  const currentVersions = useDeviceStore(state => {
    const { appVersion, systemVersion } = state;
    if (!appVersion || !systemVersion) return null;
    return { appVersion, systemVersion };
  });

  useEffect(() => {
    send("getAutoUpdateState", {}, resp => {
      if ("error" in resp) return;
      setAutoUpdate(resp.result as boolean);
    });
  }, [send]);

  const handleAutoUpdateChange = (enabled: boolean) => {
    send("setAutoUpdateState", { enabled }, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to set auto-update: ${resp.error.data || "Unknown error"}`,
        );
        return;
      }
      setAutoUpdate(enabled);
    });
  };

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title={$at("General")}
        description={$at("Configure device settings and update preferences")}
      />

      <div className="space-y-4">
        <div className="space-y-4 pb-2">
          <div className="mt-2 flex items-center justify-between gap-x-2">
            <SettingsItem
              title={$at("Version")}
              description={
                currentVersions ? (
                  <>
                    {$at("App")}: {currentVersions.appVersion}
                    <br />
                    {$at("System")}: {currentVersions.systemVersion}
                  </>
                ) : (
                  <>
                    {$at("App: Loading...")}
                    <br />
                    {$at("System: Loading...")}
                  </>
                )
              }
            />
            <div>
              <Button className="hidden"
                size="SM"
                theme="light"
                text={$at("Check for Updates")}
                onClick={() => navigateTo("./update")}
              />
            </div>
          </div>
          <div className="hidden space-y-4">
            <SettingsItem
              title={$at("Auto Update")}
              description={$at("Automatically update the device to the latest version")}
            >
              <Checkbox
                checked={autoUpdate}
                onChange={e => {
                  handleAutoUpdateChange(e.target.checked);
                }}
              />
            </SettingsItem>
          </div>
        </div>
      </div>
    </div>
);
}
