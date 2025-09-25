import { ActionFunctionArgs, Form, redirect, useActionData } from "react-router-dom";
import { useState, useRef, useEffect } from "react";
import { LuEye, LuEyeOff } from "react-icons/lu";

import GridBackground from "@components/GridBackground";
import Container from "@components/Container";
import Fieldset from "@components/Fieldset";
import { InputFieldWithLabel } from "@components/InputField";
import { Button } from "@components/Button";
import LogoLuckfox from "@/assets/logo-luckfox.png";
import { DEVICE_API } from "@/ui.config";

import api from "../api";
import { useReactAt } from 'i18n-auto-extractor/react'
import DashboardNavbar from "@/components/Header";

import { DeviceStatus } from "./welcome-local";

const loader = async () => {
  const res = await api
    .GET(`${DEVICE_API}/device/status`)
    .then(res => res.json() as Promise<DeviceStatus>);

  if (res.isSetup) return redirect("/login-local");
  return null;
};

const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const password = formData.get("password");
  const confirmPassword = formData.get("confirmPassword");

  if (password !== confirmPassword) {
    return { error: "Passwords do not match" };
  }

  try {
    const response = await api.POST(`${DEVICE_API}/device/setup`, {
      localAuthMode: "password",
      password,
    });

    if (response.ok) {
      return redirect("/");
    } else {
      return { error: "Failed to set password" };
    }
  } catch (error) {
    console.error("Error setting password:", error);
    return { error: "An error occurred while setting the password" };
  }
};

export default function WelcomeLocalPasswordRoute() {
  const { $at }= useReactAt();
  const actionData = useActionData() as { error?: string };
  const [showPassword, setShowPassword] = useState(false);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  // Don't focus immediately, let the animation finish
  useEffect(() => {
    const timer = setTimeout(() => {
      passwordInputRef.current?.focus();
    }, 1000); // 1 second delay

    return () => clearTimeout(timer);
  }, []);

  return (
    <>
      <DashboardNavbar
        primaryLinks={[]}
        showConnectionStatus={false}
        isLoggedIn={false}
        kvmName={"PicoKVM Device"}
      />
      <GridBackground />
      <div className="grid min-h-screen">
        <Container>
          <div className="isolate flex h-full w-full items-center justify-center">
            <div className="max-w-2xl space-y-8"> 
              <div className="animate-fadeIn flex items-center justify-center opacity-0">
                <img
                  src={LogoLuckfox}
                  alt=""
                  className="-ml-4 hidden h-[32px] dark:block"
                />
                <img src={LogoLuckfox} alt="" className="-ml-4 h-[32px] dark:hidden" />
              </div>

              <div
                className="animate-fadeIn space-y-2 text-center opacity-0"
                style={{ animationDelay: "200ms" }}
              >
                <h1 className="text-4xl font-semibold text-black dark:text-white">
                  {$at("Set a Password")}
                </h1>
                <p className="font-medium text-slate-600 dark:text-slate-400">
                  {$at("Create a strong password to secure your KVM device locally.")}
                </p>
              </div>

              <Fieldset className="space-y-12">
                <Form method="POST" className="mx-auto max-w-sm space-y-4">
                  <div className="space-y-4">
                    <div
                      className="animate-fadeIn opacity-0"
                      style={{ animationDelay: "400ms" }}
                    >
                      <InputFieldWithLabel
                        label={$at("Password")}
                        type={showPassword ? "text" : "password"}
                        name="password"
                        placeholder={$at("Enter a password")}
                        autoComplete="new-password"
                        ref={passwordInputRef}
                        TrailingElm={
                          showPassword ? (
                            <div
                              onClick={() => setShowPassword(false)}
                              className="pointer-events-auto"
                            >
                              <LuEye className="h-4 w-4 cursor-pointer text-slate-500 dark:text-slate-400" />
                            </div>
                          ) : (
                            <div
                              onClick={() => setShowPassword(true)}
                              className="pointer-events-auto"
                            >
                              <LuEyeOff className="h-4 w-4 cursor-pointer text-slate-500 dark:text-slate-400" />
                            </div>
                          )
                        }
                      />
                    </div>
                    <div
                      className="animate-fadeIn opacity-0"
                      style={{ animationDelay: "400ms" }}
                    >
                      <InputFieldWithLabel
                        label={$at("Confirm Password")}
                        autoComplete="new-password"
                        type={showPassword ? "text" : "password"}
                        name="confirmPassword"
                        placeholder={$at("Confirm your password")}
                        error={actionData?.error}
                      />
                    </div>
                  </div>

                  {actionData?.error && <p className="text-sm text-red-600">{}</p>}

                  <div
                    className="animate-fadeIn opacity-0"
                    style={{ animationDelay: "600ms" }}
                  >
                    <Button
                      size="LG"
                      theme="primary"
                      fullWidth
                      type="submit"
                      text={$at("Set Password")}
                      textAlign="center"
                    />
                  </div>
                </Form>
              </Fieldset>

              <p
                className="animate-fadeIn max-w-md text-center text-xs text-slate-500 opacity-0 dark:text-slate-400"
                style={{ animationDelay: "800ms" }}
              >
                {$at("This password will be used to secure your device data and protect against unauthorized access.")}{" "}
                <span className="font-bold">{$at("All data remains on your local device.")}</span>
              </p>
            </div>
          </div>
        </Container>
      </div>
    </>

  );
}

WelcomeLocalPasswordRoute.action = action;
WelcomeLocalPasswordRoute.loader = loader;
