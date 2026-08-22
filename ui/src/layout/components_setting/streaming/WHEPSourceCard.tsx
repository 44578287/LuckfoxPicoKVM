import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Tag } from "antd";

import { SettingsItem } from "@components/Settings/SettingsView";
import { useJsonRpc } from "@/hooks/useJsonRpc";
import notifications from "@/notifications";
import { useEnhancedAt } from "@/locales/enhanced";

export default function WHEPSourceCard() {
  const { $eat } = useEnhancedAt();
  const [send] = useJsonRpc();
  const [apiKey, setApiKey] = useState("");

  const host = window.location.hostname;
  const whepURL = useMemo(() => `http://${host}:8083/whep`, [host]);
  const go2rtcSource = useMemo(() => {
    const password = apiKey ? encodeURIComponent(apiKey) : "YOUR_API_KEY";
    return `webrtc:http://go2rtc:${password}@${host}:8083/whep`;
  }, [apiKey, host]);

  useEffect(() => {
    send("getApiKey", {}, resp => {
      if ("error" in resp) return;
      setApiKey(String(resp.result || ""));
    });
  }, [send]);

  const copyText = useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notifications.success(`${$eat("Copied")}: ${$eat(label)}`);
    } catch {
      notifications.error(`${$eat("Copy failed")}: ${$eat(label)}`);
    }
  }, [$eat]);

  return (
    <>
      <SettingsItem
        title={$eat("WebRTC / WHEP")}
        description={$eat("Lowest-latency direct WebRTC source for go2rtc, Frigate and compatible relays")}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Tag color="green">WHEP</Tag>
          <Tag>TCP 8083</Tag>
          <Button onClick={() => copyText(whepURL, "WHEP URL")}>{$eat("Copy WHEP URL")}</Button>
          <Button type="primary" onClick={() => copyText(go2rtcSource, "go2rtc source")}>{$eat("Copy go2rtc source")}</Button>
        </div>
      </SettingsItem>

      <div className="space-y-2 rounded-lg border border-slate-200 p-4 text-sm dark:border-slate-700">
        <div className="text-xs text-slate-500 dark:text-slate-400">{$eat("WHEP endpoint")}</div>
        <div className="break-all font-mono">{whepURL}</div>
        <div className="text-xs text-slate-500 dark:text-slate-400">go2rtc</div>
        <div className="break-all font-mono">picokvm: {go2rtcSource}</div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {$eat("WHEP shares the same RV1106 hardware encoder and read-only WebRTC viewer pool. H.264 is recommended for the broadest WebRTC compatibility.")}
        </div>
      </div>
    </>
  );
}
