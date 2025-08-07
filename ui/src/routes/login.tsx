import { useLocation, useSearchParams } from "react-router-dom";

import AuthLayout from "@components/AuthLayout";

export default function LoginRoute() {
  const [sq] = useSearchParams();
  const location = useLocation();
  const deviceId = sq.get("deviceId") || location.state?.deviceId;

  if (deviceId) {
    return (
      <AuthLayout
        showCounter={true}
        title="Connect your KVM to the cloud"
        description="Unlock remote access and advanced features for your device"
        // Header CTA
        cta="Don't have an account?"
        ctaHref={`/signup?${sq.toString()}`}
      />
    );
  }

  return (
    <AuthLayout
      title="Log in to your KVM account"
      description="Log in to access and manage your devices securely"
      // Header CTA
      cta="New to KVM?"
      ctaHref={`/signup?${sq.toString()}`}
    />
  );
}
