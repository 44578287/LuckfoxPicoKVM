import { Button } from "@components/Button";
import { LuSun, LuSunset } from "react-icons/lu";
import Card from "@components/Card";
import { SettingsPageHeader } from "@components/SettingsPageheader";
import { useJsonRpc } from "@/hooks/useJsonRpc";
import { useEffect, useState } from "react";
import notifications from "@/notifications";
import { cx } from "@/cva.config";

interface IOSettings {
  io0Status: boolean;
  io1Status: boolean;
}


export function IOControl() {
  const [send] = useJsonRpc();
  const [settings, setSettings] = useState<IOSettings>({
    io0Status: true,
    io1Status: true,
  });

  useEffect(() => {
    send("getIOSettings", {}, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to get IO settings: ${resp.error.data || "Unknown error"}`,
        );
        return;
      }
      setSettings(resp.result as IOSettings);
    });
  }, [send]);

  const handleSettingChange = (setting: keyof IOSettings, value: boolean) => {
    const newSettings = { ...settings, [setting]: value };
    send("setIOSettings", { settings: newSettings }, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to update IO settings: ${resp.error.data || "Unknown error"}`,
        );
        return;
      }
      setSettings(newSettings);
    });
  };


  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title="IO Control"
        description="Configure your io control settings"
      />

      <hr className="border-slate-700/30 dark:border-slate-600/30" />
      
      <Card className="animate-fadeIn opacity-0">
        <div className="space-y-2 p-1">
          <div className="flex items-center gap-2">
            <div className="text-bm text-black dark:text-slate-300">IO_0</div>
            <div className={cx("w-2 h-2 rounded-full bg-red-400", {
              hidden: !settings.io0Status
            })} /> 
          </div>
          <div className="flex justify-between gap-x-6">
            <Button
              size="SM"
              theme="primary"
              LeadingIcon={LuSun}
              text="High"
              onClick={() => {
                handleSettingChange("io0Status", true);
              }}
            />
            <Button
              size="SM"
              theme="primary"
              LeadingIcon={LuSunset}
              text="Low"
              onClick={() => {
                handleSettingChange("io0Status", false);
              }}
            />
            <div className="w-4"></div>
          </div>
        </div>
        
        <div className="space-y-2 p-1">
          <div className="flex items-center gap-2">
            <div className="text-bm text-black dark:text-slate-300">IO_1</div>
            <div className={cx("w-2 h-2 rounded-full bg-red-400", {
              hidden: !settings.io1Status
            })} /> 
          </div>
          <div className="flex justify-between gap-x-6">
            <Button
              size="SM"
              theme="primary"
              LeadingIcon={LuSun}
              text="High"
              onClick={() => {
                handleSettingChange("io1Status", true);
              }}
            />
            <Button
              size="SM"
              theme="primary"
              LeadingIcon={LuSunset}
              text="Low"
              onClick={() => {
                handleSettingChange("io1Status", false);
              }}
            />
            <div className="w-4"></div>
          </div>
        </div>
        
        <div className="h-2"></div>
      </Card>
    </div>
  );
}
