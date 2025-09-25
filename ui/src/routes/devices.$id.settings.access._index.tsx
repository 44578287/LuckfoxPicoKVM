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
import {useReactAt} from 'i18n-auto-extractor/react'


import AutoHeight from "@/components/AutoHeight";


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

export interface EasyTierRunningResponse {
  running: boolean;
}

export interface EasyTierResponse {
  name: string;
  secret: string;
  node: string;
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
  const { $at }= useReactAt();
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
  const [frpcRunningStatus, setFrpcRunningStatus] = useState<FrpcResponse>({ running: false });
  
  const [tempEasyTierNetworkName, setTempEasyTierNetworkName] = useState("");
  const [tempEasyTierNetworkSecret, setTempEasyTierNetworkSecret] = useState("");
  const [tempEasyTierNetworkNodeMode, setTempEasyTierNetworkNodeMode] = useState("default");
  const [tempEasyTierNetworkNode, setTempEasyTierNetworkNode] = useState("tcp://public.easytier.cn:11010");
  const [easyTierRunningStatus, setEasyTierRunningStatus] = useState<EasyTierRunningResponse>({ running: false });
  const [showEasyTierLogModal, setShowEasyTierLogModal] = useState(false);
  const [showEasyTierNodeInfoModal, setShowEasyTierNodeInfoModal] = useState(false);
  const [easyTierLog, setEasyTierLog] = useState<string>("");
  const [easyTierNodeInfo, setEasyTierNodeInfo] = useState<string>("");
  const [easyTierConfig, setEasyTierConfig] = useState<EasyTierResponse>({
    name: "",
    secret: "",
    node: "",
  });


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

  const handleTailScaleCancel = useCallback(() => { 
    setIsDisconnecting(true);
    send("cancelTailScale", {}, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to cancel TailScale: ${resp.error.data || "Unknown error"}`,
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
    send("stopFrpc", {}, resp => {
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

  const handleStartEasyTier = useCallback(() => {
    if (!tempEasyTierNetworkName || !tempEasyTierNetworkSecret || !tempEasyTierNetworkNode) {
      notifications.error("Please enter EasyTier network name, secret and node");
      return;
    }
    setEasyTierConfig({
      name: tempEasyTierNetworkName,
      secret: tempEasyTierNetworkSecret,
      node: tempEasyTierNetworkNode,
    });
    send("startEasyTier", { name: tempEasyTierNetworkName, secret: tempEasyTierNetworkSecret, node: tempEasyTierNetworkNode }, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to start EasyTier: ${resp.error.data || "Unknown error"}`,
        );
        setEasyTierRunningStatus({ running: false });
        return;
      }
      notifications.success("EasyTier started");
      setEasyTierRunningStatus({ running: true });
    });
  }, [send, tempEasyTierNetworkName, tempEasyTierNetworkSecret, tempEasyTierNetworkNode]);

  const handleStopEasyTier = useCallback(() => {
    send("stopEasyTier", {}, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to stop EasyTier: ${resp.error.data || "Unknown error"}`,
        );
        return;
      }
      notifications.success("EasyTier stopped");
      setEasyTierRunningStatus({ running: false });
    });
  }, [send]);

  const handleGetEasyTierLog = useCallback(() => {
    send("getEasyTierLog", {}, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to get EasyTier log: ${resp.error.data || "Unknown error"}`,
        );
        setEasyTierLog("");
        return;
      }
      setEasyTierLog(resp.result as string);
      setShowEasyTierLogModal(true);
    });
  }, [send]);
  
  const handleGetEasyTierNodeInfo = useCallback(() => {
    send("getEasyTierNodeInfo", {}, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to get EasyTier Node Info: ${resp.error.data || "Unknown error"}`,
        );
        setEasyTierNodeInfo("");
        return;
      }
      setEasyTierNodeInfo(resp.result as string);
      setShowEasyTierNodeInfoModal(true);
    });
  }, [send]);

  const getEasyTierConfig = useCallback(() => {
    send("getEasyTierConfig", {}, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to get EasyTier config: ${resp.error.data || "Unknown error"}`,
        );
        return;
      }
      const result = resp.result as EasyTierResponse;
      setEasyTierConfig({
        name: result.name,
        secret: result.secret,
        node: result.node,
      });
    });
  }, [send]);
  
  const getEasyTierStatus = useCallback(() => {
    console.log("getEasyTierStatus")
    send("getEasyTierStatus", {}, resp => {
      if ("error" in resp) {
        notifications.error(
          `Failed to get EasyTier status: ${resp.error.data || "Unknown error"}`,
        );
        return;
      }
      setEasyTierRunningStatus(resp.result as EasyTierRunningResponse);
    });
  }, [send]);
 
  useEffect(() => {
    getEasyTierConfig();
    getEasyTierStatus();
  }, [getEasyTierStatus, getEasyTierConfig]);
  
  useEffect(() => {
    if (tempEasyTierNetworkNodeMode === 'default') {
      setTempEasyTierNetworkNode('tcp://public.easytier.cn:11010');
    } else {
      setTempEasyTierNetworkNode('');
    }
  }, [tempEasyTierNetworkNodeMode]);
  

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title={$at("Access")}
        description={$at("Manage the Access Control of the device")}
      />

      {loaderData?.authMode && (
        <>
          <div className="space-y-4">
            <SettingsSectionHeader
              title={$at("Local")}
              description={$at("Manage the mode of local access to the device")}
            />
            <>
              <SettingsItem
                title={$at("HTTPS Mode")}
                badge="Experimental"
                description={$at("Configure secure HTTPS access to your device")}
              >
                <SelectMenuBasic
                  size="SM"
                  value={tlsMode}
                  onChange={e => handleTlsModeChange(e.target.value)}
                  disabled={tlsMode === "unknown"}
                  options={[
                    { value: "disabled", label: $at("Disabled") },
                    { value: "self-signed", label: $at("Self-signed") },
                    { value: "custom", label: $at("Custom") },
                  ]}
                />
              </SettingsItem>

              {tlsMode === "custom" && (
                <div className="mt-4 space-y-4">
                  <div className="space-y-4">
                    <SettingsItem
                      title={$at("TLS Certificate")}
                      description={$at("Paste your TLS certificate below. For certificate chains, include the entire chain (leaf, intermediate, and root certificates).")}
                    />
                    <div className="space-y-4">
                      <TextAreaWithLabel
                        label={$at("Certificate")}
                        rows={3}
                        placeholder={
                          $at("-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----")
                        }
                        value={tlsCert}
                        onChange={e => handleTlsCertChange(e.target.value)}
                      />
                    </div>

                    <div className="space-y-4">
                      <div className="space-y-4">
                        <TextAreaWithLabel
                          label={$at("Private Key")}
                          description={$at("For security reasons, it will not be displayed after saving.")}
                          rows={3}
                          placeholder={
                            $at("-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----")
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
                      text={$at("Update TLS Settings")}
                      onClick={handleCustomTlsUpdate}
                    />
                  </div>
                </div>
              )}

              <SettingsItem
                title={$at("Authentication Mode")}
                description={`${$at("Current mode:")} ${loaderData.authMode === "password" ? $at("Password protected") : $at("No password")}`}
              >
                {loaderData.authMode === "password" ? (
                  <Button
                    size="SM"
                    theme="light"
                    text={$at("Disable Protection")}
                    onClick={() => {
                      navigateTo("./local-auth", { state: { init: "deletePassword" } });
                    }}
                  />
                ) : (
                  <Button
                    size="SM"
                    theme="light"
                    text={$at("Enable Password")}
                    onClick={() => {
                      navigateTo("./local-auth", { state: { init: "createPassword" } });
                    }}
                  />
                )}
              </SettingsItem>
            </>

            {loaderData.authMode === "password" && (
              <SettingsItem
                title={$at("Change Password")}
                description={$at("Update your device access password")}
              >
                <Button
                  size="SM"
                  theme="light"
                  text={$at("Change Password")}
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
          title={$at("Remote")}
          description={$at("Manage the mode of Remote access to the device")}
        />

        <div className="space-y-4">
          {/* Add TailScale settings item */}
          <SettingsItem
            title="TailScale"
            badge="Experimental"
            description={$at("Connect to TailScale VPN network")}
          >
          </SettingsItem>
        </div>
          
        <AutoHeight>
          <GridCard>
            <div className="p-4">
              <div className="space-y-4"> 
                <SettingsItem
                  title=""
                  description={$at("TailScale use xEdge server")}
                >
                  <Checkbox disabled={tailScaleConnectionState !== "disconnected"}
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

                {tailScaleConnectionState === "connecting" && (
                  <div className="flex items-center justify-between gap-x-2">
                    <p>Connecting...</p>
                    <Button
                      size="SM"
                      theme="light"
                      text={$at("Cancel")}
                      onClick={handleTailScaleCancel}
                    /> 
                  </div>
                )}
                {tailScaleConnectionState === "connected" && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-x-2 justify-between">
                      {tailScaleLoginUrl && (
                        <p>{$at("Login URL:")} <a href={tailScaleLoginUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400">LoginUrl</a></p> 
                      )}
                      {!tailScaleLoginUrl && (
                        <p>{$at("Wait to obtain the Login URL")}</p> 
                      )} 
                      <Button
                        size="SM"
                        theme="light"
                        text= { isDisconnecting  ? $at("Quitting...") : $at("Quit")}
                        onClick={handleTailScaleLogout}
                        disabled={ isDisconnecting === true }
                      />
                    </div>
                  </div>
                )}
                {tailScaleConnectionState === "logined" && (
                  <div className="space-y-4">
                    <div className="flex-1 space-y-2">
                      <div className="flex justify-between border-slate-800/10 pt-2 dark:border-slate-300/20">
                        <span className="text-sm text-slate-600 dark:text-slate-400">
                          {$at("Network IP")}
                        </span>
                        <span className="text-right text-sm font-medium">
                          {tailScaleIP}
                        </span>
                      </div> 
                      <div className="flex items-center gap-x-2">
                        <Button
                          size="SM"
                          theme="light"
                          text= { isDisconnecting  ? $at("Quitting...") : $at("Quit")}
                          onClick={handleTailScaleLogout}
                          disabled={ isDisconnecting === true }
                        />
                      </div>
                    </div>
                  </div>
                )}
                {tailScaleConnectionState === "closed" && (
                  <div className="text-sm text-red-600 dark:text-red-400">
                    <p>Connect fail, please retry</p>
                  </div>    
                )}   
                { ((tailScaleConnectionState === "disconnected") || (tailScaleConnectionState === "closed")) && (
                  <Button
                    size="SM"
                    theme="light"
                    text={$at("Enable")}
                    onClick={handleTailScaleLogin}
                  />
                )}
              </div>
            </div>
          </GridCard> 
        </AutoHeight>

        <div className="space-y-4">
          {/* Add ZeroTier settings item */}
          <SettingsItem
            title="ZeroTier"
            badge="Experimental"
            description={$at("Connect to ZeroTier VPN network")}
          >
          </SettingsItem>
        </div>

        <AutoHeight>
          <GridCard>
            <div className="p-4">
              <div className="space-y-4"> 
                {zeroTierConnectionState === "connecting" && (
                  <div className="text-sm text-slate-700 dark:text-slate-300">
                    <p>{$at("Connecting...")}</p>
                  </div>
                )}
                {zeroTierConnectionState === "connected" && (
                  <div className="flex-1 space-y-2">
                    <div className="flex justify-between border-slate-800/10 pt-2 dark:border-slate-300/20">
                      <span className="text-sm text-slate-600 dark:text-slate-400">
                        {$at("Network ID")}
                      </span>
                      <span className="text-right text-sm font-medium">
                        {zeroTierNetworkID}
                      </span>
                    </div>
                    <div className="flex items-center gap-x-2">
                      <Button
                        size="SM"
                        theme="light"
                        text={$at("Quit")}
                        onClick={handleZeroTierLogout}
                      />
                    </div>
                  </div>
                )}
                {zeroTierConnectionState === "logined" && (
                  <div className="flex-1 space-y-2">
                    <div className="flex justify-between border-slate-800/10 pt-2 dark:border-slate-300/20">
                      <span className="text-sm text-slate-600 dark:text-slate-400">
                        {$at("Network ID")}
                      </span>
                      <span className="text-right text-sm font-medium">
                        {zeroTierNetworkID}
                      </span>
                    </div>
                    <div className="flex justify-between border-t border-slate-800/10 pt-2 dark:border-slate-300/20">
                      <span className="text-sm text-slate-600 dark:text-slate-400">
                        {$at("Network IP")}
                      </span>
                      <span className="text-right text-sm font-medium">
                        {zeroTierIP}
                      </span>
                    </div> 
                    <div className="flex items-center gap-x-2">
                      <Button
                        size="SM"
                        theme="light"
                        text={$at("Quit")}
                        onClick={handleZeroTierLogout}
                      />
                    </div>                
                  </div>
                )} 
                {zeroTierConnectionState === "closed" && (
                  <div className="flex items-center gap-x-2 justify-between">
                    <p>{$at("Connect fail, please retry")}</p>
                    <Button
                      size="SM"
                      theme="light"
                      text={$at("Retry")}
                      onClick={handleZeroTierLogout}
                    /> 
                  </div>
                )}
                {(zeroTierConnectionState === "disconnected") && (
                  <div className="flex items-end gap-x-2">
                    <InputFieldWithLabel
                      size="SM"
                      label={$at("Network ID")}
                      value={tempNetworkID}
                      onChange={handleZeroTierNetworkIdChange}
                      placeholder={$at("Enter ZeroTier Network ID")}
                    />
                    <Button
                      size="SM"
                      theme="light"
                      text={$at("Join in")}
                      onClick={handleZeroTierLogin}
                    />
                </div> 
                )}
              </div> 
            </div>
          </GridCard> 
        </AutoHeight>
        
        <div className="space-y-4">
          <SettingsItem
            title="EasyTier"
            description={$at("Connect to EasyTier server")}
          />
        </div>
            
        <AutoHeight>
          <GridCard>
            <div className="p-4">
              <div className="space-y-4">
               { easyTierRunningStatus.running ? (  
                <div className="flex-1 space-y-2">
                  <div className="flex justify-between border-slate-800/10 pt-2 dark:border-slate-300/20">
                    <span className="text-sm text-slate-600 dark:text-slate-400">
                      {$at("Network Name")}
                    </span>
                    <span className="text-right text-sm font-medium">
                      {easyTierConfig.name || tempEasyTierNetworkName}
                    </span>
                  </div>
                  <div className="flex justify-between border-t border-slate-800/10 pt-2 dark:border-slate-300/20">
                    <span className="text-sm text-slate-600 dark:text-slate-400">
                      {$at("Network Secret")}
                    </span>
                    <span className="text-right text-sm font-medium">
                      {easyTierConfig.secret || tempEasyTierNetworkSecret}
                    </span>
                  </div>
                  <div className="flex justify-between border-t border-slate-800/10 pt-2 dark:border-slate-300/20">
                    <span className="text-sm text-slate-600 dark:text-slate-400">
                      {$at("Network Node")}
                    </span>
                    <span className="text-right text-sm font-medium">
                      {easyTierConfig.node || tempEasyTierNetworkNode}
                    </span>
                  </div>
                   
                 <div className="flex items-center gap-x-2">
                   <Button
                     size="SM"
                     theme="danger"
                     text={$at("Stop")}
                     onClick={handleStopEasyTier}
                   />
                   <Button
                     size="SM"
                     theme="light"
                     text={$at("Log")}
                     onClick={handleGetEasyTierLog}
                   />
                   <Button
                     size="SM"
                     theme="light"
                     text={$at("Node Info")}
                     onClick={handleGetEasyTierNodeInfo}
                   />
                 </div>
                </div>
               ) : (
                <div className="space-y-4"> 
                  <div className="flex items-end gap-x-2">
                    <InputFieldWithLabel
                      size="SM"
                      label={$at("Network Name")}
                      value={tempEasyTierNetworkName}
                      onChange={e => setTempEasyTierNetworkName(e.target.value)}
                      placeholder={$at("Enter EasyTier Network Name")}
                    />
                  </div> 
                  <div className="flex items-end gap-x-2">
                    <InputFieldWithLabel
                      size="SM"
                      label={$at("Network Secret")}
                      value={tempEasyTierNetworkSecret}
                      onChange={e => setTempEasyTierNetworkSecret(e.target.value)}
                      placeholder={$at("Enter EasyTier Network Secret")}
                    />
                  </div> 

                  <div className="space-y-4">
                    <SettingsItem
                      title={$at("Network Node")}
                      description=""
                    >
                      <SelectMenuBasic
                        size="SM"
                        value={tempEasyTierNetworkNodeMode}
                        onChange={e => setTempEasyTierNetworkNodeMode(e.target.value)}
                        options={[
                          { value: "default", label: $at("Default") },
                          { value: "custom", label: $at("Custom") },
                        ]}
                      />
                    </SettingsItem>
                  </div>  
                  
                  {tempEasyTierNetworkNodeMode === "custom" && (
                    <div className="flex items-end gap-x-2">
                      <InputFieldWithLabel
                        size="SM"
                        label={$at("Network Node")}
                        value={tempEasyTierNetworkNode}
                        onChange={e => setTempEasyTierNetworkNode(e.target.value)}
                        placeholder={$at("Enter EasyTier Network Node")}
                      />
                    </div>
                  )}
                  
                 <div className="flex items-center gap-x-2">
                   <Button
                     size="SM"
                     theme="primary"
                     text={$at("Start")}
                     onClick={handleStartEasyTier}
                   />
                  </div>
                </div>
               )} 
              </div>

            </div>
          </GridCard> 
        </AutoHeight>



        <div className="space-y-4">
          <SettingsItem
            title="Frp"
            description={$at("Connect to Frp server")}
          />
        </div>

        <AutoHeight>
          <GridCard>
            <div className="p-4">
              <div className="space-y-4">
                <TextAreaWithLabel
                  label={$at("Edit frpc.toml")}
                  placeholder={$at("Enter frpc configuration")}
                  value={frpcToml || ""}
                  rows={3}
                  readOnly={frpcRunningStatus.running}
                  onChange={e => setFrpcToml(e.target.value)}
                />
                <div className="flex items-center gap-x-2">
                  { frpcRunningStatus.running ? (
                    <div className="flex items-center gap-x-2">
                      <Button
                        size="SM"
                        theme="danger"
                        text={$at("Stop")}
                        onClick={handleStopFrpc}
                      />
                      <Button
                        size="SM"
                        theme="light"
                        text={$at("Log")}
                        onClick={handleGetFrpcLog}
                      />
                    </div>
                  ) : (
                    <Button
                      size="SM"
                      theme="primary"
                      text={$at("Start")}
                      onClick={handleStartFrpc}
                    />
                  )}
                </div>
              </div>
            </div>
          </GridCard> 
        </AutoHeight>

      </div>

      <LogDialog
        open={showEasyTierLogModal}
        onClose={() => {
          setShowEasyTierLogModal(false);
        }}
        title="EasyTier Log"
        description={easyTierLog}
      />
      
      <LogDialog
        open={showEasyTierNodeInfoModal}
        onClose={() => {
          setShowEasyTierNodeInfoModal(false);
        }}
        title="EasyTier Node Info"
        description={easyTierNodeInfo}
      />
        
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
