import { useCallback, useEffect, useState } from "react";

import { GridCard } from "@components/Card";

import { Button } from "../components/Button";
import Checkbox from "../components/Checkbox";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { SettingsPageHeader } from "../components/SettingsPageheader";
import { TextAreaWithLabel } from "../components/TextArea";
import { useSettingsStore } from "../hooks/stores";
import { useJsonRpc } from "../hooks/useJsonRpc";
import { isOnDevice } from "../main";
import notifications from "../notifications";

import { SettingsItem } from "./devices.$id.settings";

export default function SettingsAdvancedRoute() {
  const [send] = useJsonRpc();

  const [sshKey, setSSHKey] = useState<string>("");
  const setDeveloperMode = useSettingsStore(state => state.setDeveloperMode);
  const [devChannel, setDevChannel] = useState(false);
  const [usbEmulationEnabled, setUsbEmulationEnabled] = useState(false);
  const [showLoopbackWarning, setShowLoopbackWarning] = useState(false);
  const [localLoopbackOnly, setLocalLoopbackOnly] = useState(false);

  const settings = useSettingsStore();

  useEffect(() => {
    send("getSSHKeyState", {}, resp => {
      if ("error" in resp) return;
      setSSHKey(resp.result as string);
    });

    send("getUsbEmulationState", {}, resp => {
      if ("error" in resp) return;
      setUsbEmulationEnabled(resp.result as boolean);
    });

    send("getLocalLoopbackOnly", {}, resp => {
      if ("error" in resp) return;
      setLocalLoopbackOnly(resp.result as boolean);
    });
  }, [send, setDeveloperMode]);

  const getUsbEmulationState = useCallback(() => {
    send("getUsbEmulationState", {}, resp => {
      if ("error" in resp) return;
      setUsbEmulationEnabled(resp.result as boolean);
    });
  }, [send]);

  const handleUsbEmulationToggle = useCallback(
    (enabled: boolean) => {
      send("setUsbEmulationState", { enabled: enabled }, resp => {
        if ("error" in resp) {
          notifications.error(
            `Failed to ${enabled ? "enable" : "disable"} USB emulation: ${resp.error.data || "Unknown error"}`,
          );
          return;
        }
        setUsbEmulationEnabled(enabled);
        getUsbEmulationState();
      });
    },
    [getUsbEmulationState, send],
  );

  const handleResetConfig = useCallback(() => {
    send("resetConfig", {}, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to reset configuration: ${resp.error.data || "Unknown error"}`,
        );
        return;
      }
      notifications.success("Configuration reset to default successfully");
    });
  }, [send]);

  const handleUpdateSSHKey = useCallback(() => {
    send("setSSHKeyState", { sshKey }, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to update SSH key: ${resp.error.data || "Unknown error"}`,
        );
        return;
      }
      notifications.success("SSH key updated successfully");
    });
  }, [send, sshKey]);

  const applyLoopbackOnlyMode = useCallback(
    (enabled: boolean) => {
      send("setLocalLoopbackOnly", { enabled }, resp => {
        if ("error" in resp) {
          notifications.error(
            `Failed to ${enabled ? "enable" : "disable"} loopback-only mode: ${resp.error.data || "Unknown error"}`,
          );
          return;
        }
        setLocalLoopbackOnly(enabled);
        if (enabled) {
          notifications.success(
            "Loopback-only mode enabled. Restart your device to apply.",
          );
        } else {
          notifications.success(
            "Loopback-only mode disabled. Restart your device to apply.",
          );
        }
      });
    },
    [send, setLocalLoopbackOnly],
  );

  const handleLoopbackOnlyModeChange = useCallback(
    (enabled: boolean) => {
      // If trying to enable loopback-only mode, show warning first
      if (enabled) {
        setShowLoopbackWarning(true);
      } else {
        // If disabling, just proceed
        applyLoopbackOnlyMode(false);
      }
    },
    [applyLoopbackOnlyMode, setShowLoopbackWarning],
  );

  const confirmLoopbackModeEnable = useCallback(() => {
    applyLoopbackOnlyMode(true);
    setShowLoopbackWarning(false);
  }, [applyLoopbackOnlyMode, setShowLoopbackWarning]);

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title="Advanced"
        description="Access additional settings for troubleshooting and customization"
      />

      <div className="space-y-4">
        <SettingsItem
          title="Loopback-Only Mode"
          description="Restrict web interface access to localhost only (127.0.0.1)"
        >
          <Checkbox
            checked={localLoopbackOnly}
            onChange={e => handleLoopbackOnlyModeChange(e.target.checked)}
          />
        </SettingsItem>

        {isOnDevice && (
          <div className="space-y-4">
            <SettingsItem
              title="SSH Access"
              description="Add your SSH public key to enable secure remote access to the device"
            />
            <div className="space-y-4">
              <TextAreaWithLabel
                label="SSH Public Key"
                value={sshKey || ""}
                rows={3}
                onChange={e => setSSHKey(e.target.value)}
                placeholder="Enter your SSH public key"
              />
              <p className="text-xs text-slate-600 dark:text-slate-400">
                The default SSH user is <strong>root</strong>.
              </p>
              <div className="flex items-center gap-x-2">
                <Button
                  size="SM"
                  theme="primary"
                  text="Update SSH Key"
                  onClick={handleUpdateSSHKey}
                />
              </div>
            </div>
          </div>
        )}

        <SettingsItem
          title="Troubleshooting Mode"
          description="Diagnostic tools and additional controls for troubleshooting and development purposes"
        >
          <Checkbox
            defaultChecked={settings.debugMode}
            onChange={e => {
              settings.setDebugMode(e.target.checked);
            }}
          />
        </SettingsItem>

        {settings.debugMode && (
          <>
            <SettingsItem
              title="USB Emulation"
              description="Control the USB emulation state"
            >
              <Button
                size="SM"
                theme="light"
                text={
                  usbEmulationEnabled ? "Disable USB Emulation" : "Enable USB Emulation"
                }
                onClick={() => handleUsbEmulationToggle(!usbEmulationEnabled)}
              />
            </SettingsItem>

            <SettingsItem
              title="Reset Configuration"
              description="Reset configuration to default. This will log you out."
            >
              <Button
                size="SM"
                theme="light"
                text="Reset Config"
                onClick={() => {
                  handleResetConfig();
                  window.location.reload();
                }}
              />
            </SettingsItem>
          </>
        )}
      </div>

      <ConfirmDialog
        open={showLoopbackWarning}
        onClose={() => {
          setShowLoopbackWarning(false);
        }}
        title="Enable Loopback-Only Mode?"
        description={
          <>
            <p>
              WARNING: This will restrict web interface access to localhost (127.0.0.1)
              only.
            </p>
            <p>Before enabling this feature, make sure you have either:</p>
            <ul className="list-disc space-y-1 pl-5 text-xs text-slate-700 dark:text-slate-300">
              <li>SSH access configured and tested</li>
              <li>Cloud access enabled and working</li>
            </ul>
          </>
        }
        variant="warning"
        confirmText="I Understand, Enable Anyway"
        onConfirm={confirmLoopbackModeEnable}
      />
    </div>
  );
}
