import StatusCard from "@components/StatusCards";

import TailscaleIcon from "@/assets/tailscale.png";
import ZeroTierIcon from "@/assets/zerotier.png";

const VpnConnectionStatusMap = {
  connected: "Connected",
  connecting: "Connecting",
  disconnected: "Disconnected",
  closed: "Closed",
  logined: "Logined",
};

export type VpnConnections = keyof typeof VpnConnectionStatusMap;

type StatusProps = {
  [key in VpnConnections]: {
    statusIndicatorClassName: string;
  };
};

export default function VpnConnectionStatusCard({
  state,
  title,
}: {
  state?: VpnConnections;
  title?: string;
}) {
  if (!state) return null;
  const StatusCardProps: StatusProps = {
    logined: {
      statusIndicatorClassName: "bg-green-500 border-green-600",
    },
    connected: {
      statusIndicatorClassName: "bg-green-500 border-green-600",
    },
    connecting: {
      statusIndicatorClassName: "bg-slate-300 border-slate-400",
    },
    disconnected: {
      statusIndicatorClassName: "bg-slate-300 border-slate-400",
    },
    closed: {
      statusIndicatorClassName: "bg-slate-300 border-slate-400",
    },  
  };
  const props = StatusCardProps[state];
  if (!props) return;
  
  const Icon = () => {
    if (title === "ZeroTier") {
      return (
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-gray-300 dark:bg-gray-800">
          <img src={ZeroTierIcon} alt="zerotier" className="h-4 w-4" />
        </span>
      );
    }
    if (title === "TailScale") {
      return (
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-gray-800 dark:bg-gray-800">
          <img src={TailscaleIcon} alt="tailscale" className="h-4 w-4" />
        </span>
      );
    }
    return null;
  };

  return (
    <StatusCard
      title={title || "Vpn Network"}
      status={VpnConnectionStatusMap[state]}
      {...StatusCardProps[state]}
    />
  );
}
