import { useCallback, useState } from "react";

import { SettingsPageHeader } from "../components/SettingsPageheader";
import { SelectMenuBasic } from "../components/SelectMenuBasic";

import { SettingsItem } from "./devices.$id.settings";
import {useReactAt} from 'i18n-auto-extractor/react'

export default function SettingsAppearanceRoute() {
  const { $at }= useReactAt();
  const [currentTheme, setCurrentTheme] = useState(() => {
    return localStorage.theme || "system";
  });

  const handleThemeChange = useCallback((value: string) => {
    const root = document.documentElement;

    if (value === "system") {
      localStorage.removeItem("theme");
      // Check system preference
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
      root.classList.remove("light", "dark");
      root.classList.add(systemTheme);
    } else {
      localStorage.theme = value;
      root.classList.remove("light", "dark");
      root.classList.add(value);
    }
  }, []);

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title={$at("Appearance")}
        description={$at("Customize the look and feel of your KVM interface")}
      />
      <SettingsItem title={$at("Theme")} description={$at("Choose your preferred color theme")}>
        <SelectMenuBasic
          size="SM"
          label=""
          value={currentTheme}
          options={[
            { value: "system", label: $at("System") },
            { value: "light", label: $at("Light") },
            { value: "dark", label: $at("Dark") },
          ]}
          onChange={e => {
            setCurrentTheme(e.target.value);
            handleThemeChange(e.target.value);
          }}
        />
      </SettingsItem>
    </div>
  );
}
