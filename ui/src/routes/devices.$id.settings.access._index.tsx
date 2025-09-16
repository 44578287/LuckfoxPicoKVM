import { useLoaderData, useNavigate } from "react-router-dom";
import { ShieldCheckIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";

import api from "@/api";
import { SettingsPageHeader } from "@components/SettingsPageheader";
import { GridCard } from "@/components/Card";
import { Button, LinkButton } from "@/components/Button";
import { InputFieldWithLabel } from "@/components/InputField";
import { SelectMenuBasic } from "@/components/SelectMenuBasic";
import { SettingsSectionHeader } from "@/components/SettingsSectionHeader";
import { useDeviceUiNavigation } from "@/hooks/useAppNavigation";
import notifications from "@/notifications";
import { DEVICE_API } from "@/ui.config";
import { useJsonRpc } from "@/hooks/useJsonRpc";
import { isOnDevice } from "@/main";
import { TextAreaWithLabel } from "@components/TextArea";

import { LocalDevice } from "./devices.$id";
import { SettingsItem } from "./devices.$id.settings";
import { CloudState } from "./adopt";
import { useVpnStore } from "@/hooks/stores";
import Checkbox from "../components/Checkbox";

import { LogDialog } from "../components/LogDialog";

export interface TailScaleResponse {
  state: string;
  loginUrl: string;
  ip: string;
  xEdge: boolean;
}

export interface ZeroTierResponse {
  state: string;
  networkID: string;
  ip: string;
}

export interface FrpcResponse {
  running: boolean;
}


export interface TLSState {
  mode: "self-signed" | "custom" | "disabled";
  certificate?: string;
  privateKey?: string;
}

const loader = async () => {
  if (isOnDevice) {
    const status = await api
      .GET(`${DEVICE_API}/device`)
      .then(res => res.json() as Promise<LocalDevice>);
    return status;
  }
  return null;
};

export default function SettingsAccessIndexRoute() {
  const loaderData = useLoaderData() as LocalDevice | null;

  const { navigateTo } = useDeviceUiNavigation();

  const [send] = useJsonRpc();

  const [deviceId, setDeviceId] = useState<string | null>(null);

  // Use a simple string identifier for the selected provider
  const [tlsMode, setTlsMode] = useState<string>("unknown");
  const [tlsCert, setTlsCert] = useState<string>("");
  const [tlsKey, setTlsKey] = useState<string>("");
    
  const tailScaleConnectionState = useVpnStore(state => state.tailScaleConnectionState);
  const tailScaleLoginUrl = useVpnStore(state => state.tailScaleLoginUrl);
  const tailScaleXEdge = useVpnStore(state => state.tailScaleXEdge)
  const tailScaleIP = useVpnStore(state => state.tailScaleIP);
  const setTailScaleConnectionState = useVpnStore(state => state.setTailScaleConnectionState);
  const setTailScaleLoginUrl = useVpnStore(state => state.setTailScaleLoginUrl); 
  const setTailScaleXEdge = useVpnStore(state => state.setTailScaleXEdge);
  const setTailScaleIP = useVpnStore(state => state.setTailScaleIP);
  
  const zeroTierConnectionState = useVpnStore(state => state.zeroTierConnectionState);
  const zeroTierNetworkID = useVpnStore(state => state.zeroTierNetworkID);
  const zeroTierIP = useVpnStore(state => state.zeroTierIP);
  const setZeroTierConnectionState = useVpnStore(state => state.setZeroTierConnectionState);
  const setZeroTierNetworkID = useVpnStore(state => state.setZeroTierNetworkID);
  const setZeroTierIP = useVpnStore(state => state.setZeroTierIP);

  const [tempNetworkID, setTempNetworkID] = useState("");
  const [isDisconnecting, setIsDisconnecting] = useState(false);
 
  const [frpcToml, setFrpcToml] = useState<string>("");
  const [frpcLog, setFrpcLog] = useState<string>("");
  const [showFrpcLogModal, setShowFrpcLogModal] = useState(false);
  const [frpcStatus, setFrpcRunningStatus] = useState<FrpcResponse>({ running: false });

  const getTLSState = useCallback(() => {
    send("getTLSState", {}, resp => {
      if ("error" in resp) return console.error(resp.error);
      const tlsState = resp.result as TLSState;

      setTlsMode(tlsState.mode);
      if (tlsState.certificate) setTlsCert(tlsState.certificate);
      if (tlsState.privateKey) setTlsKey(tlsState.privateKey);
    });
  }, [send]);

  // Function to update TLS state - accepts a mode parameter
  const updateTlsState = useCallback(
    (mode: string, cert?: string, key?: string) => {
      const state = { mode } as TLSState;
      if (cert && key) {
        state.certificate = cert;
        state.privateKey = key;
      }

      send("setTLSState", { state }, resp => {
        if ("error" in resp) {
          notifications.error(
            `Failed to update TLS settings: ${resp.error.data || "Unknown error"}`,
          );
          return;
        }

        notifications.success("TLS settings updated successfully");
      });
    },
    [send],
  );

  // Handle TLS mode change
  const handleTlsModeChange = (value: string) => {
    setTlsMode(value);

    // For "disabled" and "self-signed" modes, immediately apply the settings
    if (value !== "custom") {
      updateTlsState(value);
    }
  };

  const handleTlsCertChange = (value: string) => {
    setTlsCert(value);
  };

  const handleTlsKeyChange = (value: string) => {
    setTlsKey(value);
  };

  // Update the custom TLS settings button click handler
  const handleCustomTlsUpdate = () => {
    updateTlsState(tlsMode, tlsCert, tlsKey);
  };

  // Fetch device ID and cloud state on component mount
  useEffect(() => {
    getTLSState();

    send("getDeviceID", {}, async resp => {
      if ("error" in resp) return console.error(resp.error);
      setDeviceId(resp.result as string);
    });
  }, [send, getTLSState]);

  const handleTailScaleLogin = useCallback(() => {
    setTailScaleConnectionState("connecting");

    send("loginTailScale", { xEdge: tailScaleXEdge }, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to login TailScale: ${resp.error.data || "Unknown error"}`,
        );
        setTailScaleConnectionState("closed");
        setTailScaleLoginUrl("");
        setTailScaleIP("");
        return;
      }
      const result = resp.result as TailScaleResponse;
      const validState = ["closed", "connecting", "connected", "disconnected" , "logined"].includes(result.state)
      ? result.state as "closed" | "connecting" | "connected" | "disconnected" | "logined"
      : "closed";
      setTailScaleConnectionState(validState);
      setTailScaleLoginUrl(result.loginUrl);
      setTailScaleIP(result.ip);
    });
  }, [send, tailScaleXEdge]);

  const handleTailScaleXEdgeChange = (enabled: boolean) => {
    setTailScaleXEdge(enabled);
  };

  const handleTailScaleLogout = useCallback(() => { 
    setIsDisconnecting(true);
    send("logoutTailScale", {}, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to logout TailScale: ${resp.error.data || "Unknown error"}`,
        );  
        setIsDisconnecting(false);
        return;
      }
      setTailScaleConnectionState("disconnected"); 
      setTailScaleLoginUrl("");
      setTailScaleIP("");  
      setIsDisconnecting(false);
    });
  },[send]);

  const handleTailScaleCanel = useCallback(() => { 
    setIsDisconnecting(true);
    send("canelTailScale", {}, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to logout TailScale: ${resp.error.data || "Unknown error"}`,
        );  
        setIsDisconnecting(false);
        return;
      }
      setTailScaleConnectionState("disconnected"); 
      setTailScaleLoginUrl("");
      setTailScaleIP("");  
      setIsDisconnecting(false);
    });
  },[send]);

  const handleZeroTierLogin = useCallback(() => {  
    setZeroTierConnectionState("connecting");
    const currentNetworkID = tempNetworkID;
    
    if (!/^[0-9a-f]{16}$/.test(currentNetworkID)) {
      notifications.error("Please enter a valid Network ID");
    setZeroTierConnectionState("disconnected");
      return;      
    }
    setZeroTierNetworkID(currentNetworkID);
    send("loginZeroTier", { networkID: currentNetworkID }, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to login ZeroTier: ${resp.error.data || "Unknown error"}`,
        );

        setZeroTierConnectionState("closed"); 
        setZeroTierNetworkID("");
        setZeroTierIP("");
        return;
      }

      const result = resp.result as ZeroTierResponse;
      const validState = ["closed", "connecting", "connected", "disconnected" , "logined" ].includes(result.state)
      ? result.state as "closed" | "connecting" | "connected" | "disconnected" | "logined"
      : "closed";
      setZeroTierConnectionState(validState);
      setZeroTierIP(result.ip);
    });
  }, [send, tempNetworkID]);
  
  const handleZeroTierNetworkIdChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.trim();
    setTempNetworkID(value);
  }, []);

  const handleZeroTierLogout = useCallback(() => {  
    send("logoutZeroTier", { networkID: zeroTierNetworkID }, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to logout ZeroTier: ${resp.error.data || "Unknown error"}`,
        );
        return;
      }
      setZeroTierConnectionState("disconnected");
      setZeroTierNetworkID("");
      setZeroTierIP("");
    });
  },[send, zeroTierNetworkID]);

  const handleStartFrpc = useCallback(() => {
    send("startFrpc", { frpcToml }, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to start frpc: ${resp.error.data || "Unknown error"}`,
        );
        setFrpcRunningStatus({ running: false });
        return;
      }
      notifications.success("frpc started");
      setFrpcRunningStatus({ running: true });
    });
  }, [send, frpcToml]);
  
  const handleStopFrpc = useCallback(() => {
    send("stopFrpc", { frpcToml }, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to stop frpc: ${resp.error.data || "Unknown error"}`,
        );
        return;
      }
      notifications.success("frpc stopped");
      setFrpcRunningStatus({ running: false });
    });
  }, [send]);

  const handleGetFrpcLog = useCallback(() => {
    send("getFrpcLog", {}, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to get frpc log: ${resp.error.data || "Unknown error"}`,
        );
        setFrpcLog("");
        return;
      }
      setFrpcLog(resp.result as string);
      setShowFrpcLogModal(true);
    });
  }, [send]);

  const getFrpcToml = useCallback(() => {
    send("getFrpcToml", {}, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to get frpc toml: ${resp.error.data || "Unknown error"}`,
        );
        setFrpcToml("");
        return;
      }
      setFrpcToml(resp.result as string);
    });
  }, [send]);
  
  const getFrpcStatus = useCallback(() => {
    send("getFrpcStatus", {}, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to get frpc status: ${resp.error.data || "Unknown error"}`,
        );
        return;
      }
      setFrpcRunningStatus(resp.result as FrpcResponse);
    });
  }, [send]);

  useEffect(() => {
    getFrpcStatus();
    getFrpcToml();
  }, [getFrpcStatus, getFrpcToml]);

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title="Access"
        description="Manage the Access Control of the device"
      />

      {loaderData?.authMode && (
        <>
          <div className="space-y-4">
            <SettingsSectionHeader
              title="Local"
              description="Manage the mode of local access to the device"
            />
            <>
              <SettingsItem
                title="HTTPS Mode"
                badge="Experimental"
                description="Configure secure HTTPS access to your device"
              >
                <SelectMenuBasic
                  size="SM"
                  value={tlsMode}
                  onChange={e => handleTlsModeChange(e.target.value)}
                  disabled={tlsMode === "unknown"}
                  options={[
                    { value: "disabled", label: "Disabled" },
                    { value: "self-signed", label: "Self-signed" },
                    { value: "custom", label: "Custom" },
                  ]}
                />
              </SettingsItem>

              {tlsMode === "custom" && (
                <div className="mt-4 space-y-4">
                  <div className="space-y-4">
                    <SettingsItem
                      title="TLS Certificate"
                      description="Paste your TLS certificate below. For certificate chains, include the entire chain (leaf, intermediate, and root certificates)."
                    />
                    <div className="space-y-4">
                      <TextAreaWithLabel
                        label="Certificate"
                        rows={3}
                        placeholder={
                          "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
                        }
                        value={tlsCert}
                        onChange={e => handleTlsCertChange(e.target.value)}
                      />
                    </div>

                    <div className="space-y-4">
                      <div className="space-y-4">
                        <TextAreaWithLabel
                          label="Private Key"
                          description="For security reasons, it will not be displayed after saving."
                          rows={3}
                          placeholder={
                            "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
                          }
                          value={tlsKey}
                          onChange={e => handleTlsKeyChange(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-x-2">
                    <Button
                      size="SM"
                      theme="primary"
                      text="Update TLS Settings"
                      onClick={handleCustomTlsUpdate}
                    />
                  </div>
                </div>
              )}

              <SettingsItem
                title="Authentication Mode"
                description={`Current mode: ${loaderData.authMode === "password" ? "Password protected" : "No password"}`}
              >
                {loaderData.authMode === "password" ? (
                  <Button
                    size="SM"
                    theme="light"
                    text="Disable Protection"
                    onClick={() => {
                      navigateTo("./local-auth", { state: { init: "deletePassword" } });
                    }}
                  />
                ) : (
                  <Button
                    size="SM"
                    theme="light"
                    text="Enable Password"
                    onClick={() => {
                      navigateTo("./local-auth", { state: { init: "createPassword" } });
                    }}
                  />
                )}
              </SettingsItem>
            </>

            {loaderData.authMode === "password" && (
              <SettingsItem
                title="Change Password"
                description="Update your device access password"
              >
                <Button
                  size="SM"
                  theme="light"
                  text="Change Password"
                  onClick={() => {
                    navigateTo("./local-auth", { state: { init: "updatePassword" } });
                  }}
                />
              </SettingsItem>
            )}
          </div>
          <div className="h-px w-full bg-slate-800/10 dark:bg-slate-300/20" />
        </>
      )}

      <div className="space-y-4">
        <SettingsSectionHeader
          title="Remote"
          description="Manage the mode of Remote access to the device"
        />

      <div className="space-y-4">
        {/* Add TailScale settings item */}
        <SettingsItem
          title="TailScale"
          badge="Experimental"
          description="Connect to TailScale VPN network"
        >
        </SettingsItem>
        <SettingsItem
          title=""
          description="TailScale use xEdge server"
        >
          <Checkbox
            checked={tailScaleXEdge}
            onChange={e => {
              if (tailScaleConnectionState !== "disconnected") {
                notifications.error("TailScale is running and this setting cannot be modified");
                return;
              }
              handleTailScaleXEdgeChange(e.target.checked);
            }}
          />
        </SettingsItem>
        <SettingsItem
          title=""
          description=""
        >
          <div className="space-y-4">
            { ((tailScaleConnectionState === "disconnected") || (tailScaleConnectionState === "closed")) && (
              <Button
                size="SM"
                theme="light"
                text="Enable"
                onClick={handleTailScaleLogin}
              />
            )}
          </div>
        </SettingsItem>
      </div>
              
      <div className="space-y-4">
        {tailScaleConnectionState === "connecting" && (
          <div className="flex items-center justify-between gap-x-2">
            <p>Connecting...</p>
            <Button
              size="SM"
              theme="light"
              text="Canel"
              onClick={handleTailScaleCanel}
            /> 
          </div>
        )}
        {tailScaleConnectionState === "connected" && (
          <div className="space-y-4">
            <div className="flex items-center gap-x-2 justify-between">
              {tailScaleLoginUrl && (
                <p>Login URL: <a href={tailScaleLoginUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400">LoginUrl</a></p> 
              )}
              {!tailScaleLoginUrl && (
                <p>Wait to obtain the Login URL</p> 
              )} 
              <Button
                size="SM"
                theme="light"
                text= { isDisconnecting  ? "Quitting..." : "Quit"}
                onClick={handleTailScaleLogout}
                disabled={ isDisconnecting === true }
              />
            </div>
          </div>
        )}
        {tailScaleConnectionState === "logined" && (
          <div className="space-y-4">
            <div className="flex items-center gap-x-2 justify-between">
              <p>IP: {tailScaleIP}</p>
              <Button
                size="SM"
                theme="light"
                text= { isDisconnecting  ? "Quitting..." : "Quit"}
                onClick={handleTailScaleLogout}
                disabled={ isDisconnecting === true }
              />
            </div>
          </div>
        )}
        {tailScaleConnectionState === "closed" && (
          <div className="text-sm text-red-600 dark:text-red-400">
            <p>Connect fail, please retry</p>
          </div>    
        )}  
      </div>

      <div className="space-y-4">
        {/* Add ZeroTier settings item */}
        <SettingsItem
          title="ZeroTier"
          badge="Experimental"
          description="Connect to ZeroTier VPN network"
        >
        </SettingsItem>
      </div>

      <div className="space-y-4"> 
        {zeroTierConnectionState === "connecting" && (
          <div className="text-sm text-slate-700 dark:text-slate-300">
            <p>Connecting...</p>
          </div>
        )}
        {zeroTierConnectionState === "connected" && (
          <div className="space-y-4">
            <div className="flex items-center gap-x-2 justify-between">
              <p>Network ID: {zeroTierNetworkID}</p>
              <Button
                size="SM"
                theme="light"
                text="Quit"
                onClick={handleZeroTierLogout}
              />
            </div>
          </div>
        )}
       {zeroTierConnectionState === "logined" && (
          <div className="space-y-4">
            <div className="flex items-center gap-x-2 justify-between">
              <p>Network ID: {zeroTierNetworkID}</p>
              <Button
                size="SM"
                theme="light"
                text="Quit"
                onClick={handleZeroTierLogout}
              />              
            </div>
            <div className="flex items-center gap-x-2 justify-between">
              <p>Network IP: {zeroTierIP}</p>
            </div>
          </div>
       )} 
       {zeroTierConnectionState === "closed" && (
          <div className="flex items-center gap-x-2 justify-between">
            <p>Connect fail, please retry</p>
            <Button
              size="SM"
              theme="light"
              text="Retry"
              onClick={handleZeroTierLogout}
            /> 
          </div>
        )
       }
      </div>
      
      <div className="space-y-4"> 
        {(zeroTierConnectionState === "disconnected") && (
          <div className="flex items-end gap-x-2">
            <InputFieldWithLabel
              size="SM"
              label="Network ID"
              value={tempNetworkID}
              onChange={handleZeroTierNetworkIdChange}
              placeholder="Enter ZeroTier Network ID"
            /> 
            <Button
              size="SM"
              theme="light"
              text="Join in"
              onClick={handleZeroTierLogin}
            />
          </div> 
        )}
      </div>    

      <div className="space-y-4">
        <SettingsItem
          title="Frp"
          description="Connect to Frp Server"
        />
          <div className="space-y-4">
            <TextAreaWithLabel
              label="Edit frpc.toml"
              placeholder="Enter frpc settings"
              value={frpcToml || ""}
              rows={3}
              onChange={e => setFrpcToml(e.target.value)}
            />
            <div className="flex items-center gap-x-2">
              {frpcStatus.running ? (
                <div className="flex items-center gap-x-2">
                  <Button
                    size="SM"
                    theme="danger"
                    text="Stop frpc"
                    onClick={handleStopFrpc}
                  />
                  <Button
                    size="SM"
                    theme="light"
                    text="Log"
                    onClick={handleGetFrpcLog}
                  />
                </div>
              ) : (
                <Button
                  size="SM"
                  theme="primary"
                  text="Start frpc"
                  onClick={handleStartFrpc}
                />
              )}
            </div>
          </div>
      </div>

      </div>

      <LogDialog
        open={showFrpcLogModal}
        onClose={() => {
          setShowFrpcLogModal(false);
        }}
        title="Frpc Log"
        description={frpcLog}
      />

    </div>
  );
}

SettingsAccessIndexRoute.loader = loader;
