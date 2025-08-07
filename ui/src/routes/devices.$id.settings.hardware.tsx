import { useEffect, useCallback } from "react";

import { SettingsPageHeader } from "@components/SettingsPageheader";
import { SettingsItem } from "@routes/devices.$id.settings";
import { BacklightSettings, useSettingsStore } from "@/hooks/stores";
import { useJsonRpc } from "@/hooks/useJsonRpc";
import { SelectMenuBasic } from "@components/SelectMenuBasic";
import { UsbDeviceSetting } from "@components/UsbDeviceSetting";
import { InputField } from "@/components/InputField";
import { Button, LinkButton } from "@/components/Button";

import notifications from "../notifications";
import { UsbInfoSetting } from "../components/UsbInfoSetting";
import { FeatureFlag } from "../components/FeatureFlag";

export default function SettingsHardwareRoute() {
  const [send] = useJsonRpc();
  const settings = useSettingsStore();

  const setDisplayRotation = useSettingsStore(state => state.setDisplayRotation);

  const handleDisplayRotationChange = (rotation: string) => {
    setDisplayRotation(rotation);
    handleDisplayRotationSave();
  };

  const handleDisplayRotationSave = () => {
    send("setDisplayRotation", { params: { rotation: settings.displayRotation } }, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to set display orientation: ${resp.error.data || "Unknown error"}`,
        );
        return;
      }
      notifications.success("Display orientation updated successfully");
    });
  };

  const setBacklightSettings = useSettingsStore(state => state.setBacklightSettings);

  const handleBacklightSettingsChange = (settings: BacklightSettings) => {
    // If the user has set the display to dim after it turns off, set the dim_after
    // value to never.
    if (settings.dim_after > settings.off_after && settings.off_after != 0) {
      settings.dim_after = 0;
    }

    setBacklightSettings(settings);
    handleBacklightSettingsSave();
  };

  const handleBacklightSettingsSave = () => {
    send("setBacklightSettings", { params: settings.backlightSettings }, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to set backlight settings: ${resp.error.data || "Unknown error"}`,
        );
        return;
      }
      notifications.success("Backlight settings updated successfully");
    });
  };

  useEffect(() => {
    send("getBacklightSettings", {}, resp => {
      if ("error" in resp) {
        return notifications.error(
          `Failed to get backlight settings: ${resp.error.data || "Unknown error"}`,
        );
      }
      const result = resp.result as BacklightSettings;
      setBacklightSettings(result);
    });
  }, [send, setBacklightSettings]);

  const setTimeZone = useSettingsStore(state => state.setTimeZone);

  const handleTimeZoneSave = () => {
    send("setTimeZone", { timeZone: settings.timeZone }, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to set time zone: ${resp.error.data || "Unknown error"}`,
        );
        return;
      }
      notifications.success("Time zone updated successfully");
    });
  };
  
  const handleTimeZoneChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.trim();
    setTimeZone(value);
  }, []);

  useEffect(() => {
    send("getTimeZone", {}, resp => {
      if ("error" in resp) {
        return notifications.error(
          `Failed to get time zone: ${resp.error.data || "Unknown error"}`,
        );
      }
      console.log("Time zone:", resp.result);
      const result = resp.result as string;
      setTimeZone(result);
    });
  }, [send, setTimeZone]);
  
  const setLedGreenMode = useSettingsStore(state => state.setLedGreenMode);
  const setLedYellowMode = useSettingsStore(state => state.setLedYellowMode);

  const handleLedGreenModeChange = (mode: string) => {
    setLedGreenMode(mode);
    send("setLedGreenMode", { mode }, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to set LED-Green mode: ${resp.error.data || "Unknown error"}`,
        );
        return;
      }
      notifications.success("LED-Green mode updated successfully");
    });
  };

  const handleLedYellowModeChange = (mode: string) => {
    setLedYellowMode(mode);
    send("setLedYellowMode", { mode }, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to set LED-Yellow mode: ${resp.error.data || "Unknown error"}`,
        );
        return;
      }
      notifications.success("LED-Yellow mode updated successfully");
    });
  };
  
  useEffect(() => {
    send("getLedGreenMode", {}, resp => {
      if ("error" in resp) {
        return notifications.error(
          `Failed to get LED-Green mode: ${resp.error.data || "Unknown error"}`,
        );
      }
      console.log("LED-Green mode:", resp.result);
      const result = resp.result as string;
      setLedGreenMode(result);
    });    

    send("getLedYellowMode", {}, resp => {
      if ("error" in resp) {
        return notifications.error(
          `Failed to get LED-Yellow mode: ${resp.error.data || "Unknown error"}`,
        );
      }
      console.log("LED-Yellow mode:", resp.result);
      const result = resp.result as string;
      setLedYellowMode(result);
    });    
  }, [send, setLedGreenMode, setLedYellowMode]);
  
  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title="Hardware"
        description="Configure display settings and hardware options for your KVM device"
      />
      <div className="space-y-4">
        <SettingsItem
          title="Display Orientation"
          description="Set the orientation of the display"
        >
          <SelectMenuBasic
            size="SM"
            label=""
            value={settings.displayRotation.toString()}
            options={[
              { value: "180", label: "Normal" },
              { value: "90", label: "90" },
              { value: "0", label: "180" },
              { value: "270", label: "270" },
            ]}
            onChange={e => {
              settings.displayRotation = e.target.value;
              handleDisplayRotationChange(settings.displayRotation);
            }}
          />
        </SettingsItem>
        <SettingsItem
          title="Display Brightness"
          description="Set the brightness of the display"
        >
          <SelectMenuBasic
            size="SM"
            label=""
            value={settings.backlightSettings.max_brightness.toString()}
            options={[
              { value: "0", label: "Off" },
              { value: "64", label: "Low" },
              { value: "128", label: "Medium" },
              { value: "200", label: "High" },
            ]}
            onChange={e => {
              settings.backlightSettings.max_brightness = parseInt(e.target.value);
              handleBacklightSettingsChange(settings.backlightSettings);
            }}
          />
        </SettingsItem>
        {/* <SettingsItem
          title="Enable Ctrl+Alt+Del Action Bar"
          description="Enable or disable the action bar action for sending a Ctrl+Alt+Del to the host"
        >
          <Checkbox
            checked={actionBarConfig.ctrlAltDel}
            onChange={onActionBarItemChange("ctrlAltDel")}
          />
        </SettingsItem> */}
        {settings.backlightSettings.max_brightness != 0 && (
          <>
            <SettingsItem
              title="Dim Display After"
              description="Set how long to wait before dimming the display"
            >
              <SelectMenuBasic
                size="SM"
                label=""
                value={settings.backlightSettings.dim_after.toString()}
                options={[
                  { value: "0", label: "Never" },
                  { value: "60", label: "1 Minute" },
                  { value: "300", label: "5 Minutes" },
                  { value: "600", label: "10 Minutes" },
                  { value: "1800", label: "30 Minutes" },
                  { value: "3600", label: "1 Hour" },
                ]}
                onChange={e => {
                  settings.backlightSettings.dim_after = parseInt(e.target.value);
                  handleBacklightSettingsChange(settings.backlightSettings);
                }}
              />
            </SettingsItem>
            <SettingsItem
              title="Turn off Display After"
              description="Period of inactivity before display automatically turns off"
            >
              <SelectMenuBasic
                size="SM"
                label=""
                value={settings.backlightSettings.off_after.toString()}
                options={[
                  { value: "0", label: "Never" },
                  { value: "300", label: "5 Minutes" },
                  { value: "600", label: "10 Minutes" },
                  { value: "1800", label: "30 Minutes" },
                  { value: "3600", label: "1 Hour" },
                ]}
                onChange={e => {
                  settings.backlightSettings.off_after = parseInt(e.target.value);
                  handleBacklightSettingsChange(settings.backlightSettings);
                }}
              />
            </SettingsItem>
          
            <p className="text-xs text-slate-600 dark:text-slate-400">
              The display will wake up when the connection state changes, or when touched.
            </p>

          </>
        )}

        <SettingsItem
          title="Time Zone"
          description="Set the time zone for the clock"
        >
        </SettingsItem>
        <div className="space-y-4">  
          <div className="flex items-end gap-x-2">
            <InputField
              size="SM"
              value={settings.timeZone.toString()}
              onChange={handleTimeZoneChange}
              placeholder="Enter Time Zone"
            /> 
            <Button
              size="SM"
              theme="light"
              text="Set"
              onClick={handleTimeZoneSave}
            />
          </div> 
        </div>

        <SettingsItem
          title="LED-Green Type"
          description="Set the type of system status indicated by the LED-Green"
        >
          <SelectMenuBasic
            size="SM"
            label=""
            value={settings.ledGreenMode.toString()}
            options={[
              { value: "network-link", label: "network-link" },
              { value: "network-tx", label: "network-tx" },
              { value: "network-rx", label: "network-rx" },
              { value: "kernel-activity", label: "kernel-activity" },
            ]}
            onChange={e => {
              settings.ledGreenMode = e.target.value;
              handleLedGreenModeChange(settings.ledGreenMode);
            }}
          />
        </SettingsItem>

        <SettingsItem
          title="LED-Yellow Type"
          description="Set the type of system status indicated by the LED-Yellow"
        >
          <SelectMenuBasic
            size="SM"
            label=""
            value={settings.ledYellowMode.toString()}
            options={[
              { value: "network-link", label: "network-link" },
              { value: "network-tx", label: "network-tx" },
              { value: "network-rx", label: "network-rx" },
              { value: "kernel-activity", label: "kernel-activity" },
            ]}
            onChange={e => {
              settings.ledYellowMode = e.target.value;
              handleLedYellowModeChange(settings.ledYellowMode);
            }}
          />
        </SettingsItem>

      </div>

      <FeatureFlag minAppVersion="0.3.8">
        <UsbDeviceSetting />
      </FeatureFlag>

      <FeatureFlag minAppVersion="0.3.8">
        <UsbInfoSetting />
      </FeatureFlag>
    </div>
  );
}
