import { useEffect, useState } from "react";
import { cx } from "cva";
import { redirect } from "react-router-dom";

import GridBackground from "@components/GridBackground";
import Container from "@components/Container";
import { LinkButton } from "@components/Button";
import LogoLuckfox from "@/assets/logo-luckfox.png";
import LogoMark from "@/assets/logo-mark.png";
import { DEVICE_API } from "@/ui.config";

import api from "../api";

export interface DeviceStatus {
  isSetup: boolean;
}

const loader = async () => {
  const res = await api
    .GET(`${DEVICE_API}/device/status`)
    .then(res => res.json() as Promise<DeviceStatus>);

  if (res.isSetup) return redirect("/login-local");
  return null;
};

export default function WelcomeRoute() {

  return (
    <>
      <GridBackground />
      <div className="grid min-h-screen">

          <Container>
            <div className="isolate flex h-full w-full items-center justify-center">
              <div className="max-w-3xl text-center">
                <div className="space-y-8">
                  <div className="space-y-4">
                    <div className="animate-fadeIn animation-delay-1000 flex items-center justify-center opacity-0">
                      <img
                        src={LogoLuckfox}
                        alt="KVM Logo"
                        className="hidden h-[32px] dark:block"
                      />
                      <img
                        src={LogoLuckfox}
                        alt="KVM Logo"
                        className="h-[32px] dark:hidden"
                      />
                    </div>

                    <div className="animate-fadeIn animation-delay-1500 space-y-1 opacity-0">
                      <h1 className="text-4xl font-semibold text-black dark:text-white">
                        Welcome to KVM
                      </h1>
                      <p className="text-lg font-medium text-slate-600 dark:text-slate-400">
                        Control any computer remotely
                      </p>
                    </div>
                  </div>
                </div>
                <div className="-mt-8 space-y-4">
                  <p
                    style={{ animationDelay: "2000ms" }}
                    className="animate-fadeIn mx-auto max-w-lg text-lg text-slate-700 opacity-0 dark:text-slate-300"
                  >
                    KVM combines powerful hardware with intuitive software to provide a
                    seamless remote control experience.
                  </p>
                  <div className="animate-fadeIn animation-delay-2300 opacity-0">
                    <LinkButton
                      size="LG"
                      theme="light"
                      text="Set up your KVM"
                      LeadingIcon={({ className }) => (
                        <img src={LogoMark} className={cx(className, "mr-1.5 h-5!")} />
                      )}
                      textAlign="center"
                      to="/mode"
                    />
                  </div>
                </div>
              </div>
            </div>
          </Container>
      </div>
    </>
  );
}

WelcomeRoute.loader = loader;
