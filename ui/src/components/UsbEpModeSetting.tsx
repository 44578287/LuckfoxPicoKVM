import { useCallback , useEffect, useState } from "react";

import { useJsonRpc } from "../hooks/useJsonRpc";
import notifications from "../notifications";
import { SettingsItem } from "../routes/devices.$id.settings";

import Checkbox from "./Checkbox";
import { Button } from "./Button";
import { SelectMenuBasic } from "./SelectMenuBasic";
import { SettingsSectionHeader } from "./SettingsSectionHeader";
import Fieldset from "./Fieldset";
import { useUsbEpModeStore, useAudioModeStore } from "../hooks/stores";

export interface UsbDeviceConfig {
  keyboard: boolean;
  absolute_mouse: boolean;
  relative_mouse: boolean;
  mass_storage: boolean;
  mtp: boolean;
  audio: boolean;
}

const defaultUsbDeviceConfig: UsbDeviceConfig = {
  keyboard: true,
  absolute_mouse: true,
  relative_mouse: true,
  mass_storage: true,
  mtp: false,
  audio: true,
};

const usbEpOptions = [
  { value: "uac", label: "USB Audio Card"},
  { value: "mtp", label: "Media Transfer Protocol"},
  { value: "disabled", label: "Disabled"},
]

const audioModeOptions = [
  { value: "disabled", label: "Disabled"},
  { value: "usb", label: "USB"},
  //{ value: "hdmi", label: "HDMI"},
]


export function UsbEpModeSetting() {
  const usbEpMode = useUsbEpModeStore(state => state.usbEpMode)
  const setUsbEpMode = useUsbEpModeStore(state => state.setUsbEpMode)
 
  const audioMode = useAudioModeStore(state => state.audioMode);
  const setAudioMode = useAudioModeStore(state => state.setAudioMode);

  
  const [send] = useJsonRpc();
  const [loading, setLoading] = useState(false);

  const [usbDeviceConfig, setUsbDeviceConfig] =
    useState<UsbDeviceConfig>(defaultUsbDeviceConfig);

  const syncUsbDeviceConfig = useCallback(() => {
    send("getUsbDevices", {}, resp => {
      if ("error" in resp) {
        console.error("Failed to load USB devices:", resp.error);
        notifications.error(
          `Failed to load USB devices: ${resp.error.data || "Unknown error"}`,
        );
      } else {
        const usbConfigState = resp.result as UsbDeviceConfig;
        setUsbDeviceConfig(usbConfigState);
        if (usbConfigState.mtp && !usbConfigState.audio) {
          setUsbEpMode("mtp");
        } else if (usbConfigState.audio && !usbConfigState.mtp) {
          setUsbEpMode("uac");
        } else {
          setUsbEpMode("disabled");
        }
      }
    });
  }, [send]);

  const handleUsbConfigChange = useCallback(
    (devices: UsbDeviceConfig) => {
      setLoading(true);
      send("setUsbDevices", { devices }, async resp => {
        if ("error" in resp) {
          notifications.error(
            `Failed to set usb devices: ${resp.error.data || "Unknown error"}`,
          );
          setLoading(false);
          return;
        }

        // We need some time to ensure the USB devices are updated
        await new Promise(resolve => setTimeout(resolve, 2000));
        setLoading(false);
        syncUsbDeviceConfig();
        notifications.success(`USB Devices updated`);
      });
    },
    [send, syncUsbDeviceConfig],
  );

  const handleAudioModeChange = (mode: string) => {
    send("setAudioMode", { mode }, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to set Audio Mode: ${resp.error.data || "Unknown error"}`,
        );
        return;
      }

      notifications.success(`Audio Mode set to ${mode}.It takes effect after refreshing the page`);
      setAudioMode(mode);
    });
  };

  
  const handleUsbEpModeChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newMode = e.target.value;
      setUsbEpMode(newMode);
      
      if (newMode === "uac") {
        handleUsbConfigChange({
          ...usbDeviceConfig,
          audio: true,
          mtp: false,
        })
        setUsbEpMode("uac");
      } else if (newMode === "mtp") {
        handleUsbConfigChange({
          ...usbDeviceConfig,
          audio: false,
          mtp: true,
        })
        handleAudioModeChange("disabled");
        setUsbEpMode("mtp");
      } else {
        handleUsbConfigChange({
          ...usbDeviceConfig,
          audio: false,
          mtp: false,
        })
        handleAudioModeChange("disabled");
        setUsbEpMode("disabled");
      }
    },
    [handleUsbConfigChange, usbDeviceConfig],
  );

  useEffect(() => {
    syncUsbDeviceConfig();
    
    send("getAudioMode", {}, resp => {
      if ("error" in resp) return;
      setAudioMode(String(resp.result));
    });

  }, [syncUsbDeviceConfig]);

  return ( 
    <Fieldset disabled={loading} className="space-y-4">
      <div className="h-px w-full bg-slate-800/10 dark:bg-slate-300/20" />
        <SettingsItem
          loading={loading}
          title="USB Other Function"
          description="Select the active USB function (MTP or UAC)"
        >
          <SelectMenuBasic
            size="SM"
            label=""
            value={usbEpMode}
            fullWidth
            onChange={handleUsbEpModeChange}
            options={usbEpOptions}
          />
        </SettingsItem>
        
        {usbEpMode === "uac" && (
          <SettingsItem
            loading={loading}
            title="Audio Mode"
            badge="Experimental"
            description="Set the working mode of the audio"
          >
            <SelectMenuBasic
              size="SM"
              label=""
              value={audioMode}
              options={audioModeOptions}
              onChange={e => handleAudioModeChange(e.target.value)}
            />
          </SettingsItem>
        )} 
    </Fieldset>
  );
}
