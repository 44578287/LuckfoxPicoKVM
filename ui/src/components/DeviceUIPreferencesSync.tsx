import { useEffect, useRef } from "react";

import { useJsonRpc } from "@/hooks/useJsonRpc";
import { useSettingsStore } from "@/hooks/stores";
import { ThemeMode, useTheme } from "@/layout/contexts/ThemeContext";

type DeviceUIPreferences = {
  language: "en" | "zh";
  theme: ThemeMode;
  configured: boolean;
};

const validLanguage = (value: unknown): value is "en" | "zh" =>
  value === "en" || value === "zh";

const validTheme = (value: unknown): value is ThemeMode =>
  value === "light" || value === "dark";

// Synchronizes only the preferences that should follow the physical PicoKVM
// device. Browser-local input/mouse/debug preferences intentionally remain local.
export default function DeviceUIPreferencesSync() {
  const [send] = useJsonRpc();
  const language = useSettingsStore(state => state.language);
  const setLanguage = useSettingsStore(state => state.setLanguage);
  const { themeMode, setThemeMode } = useTheme();
  const loaded = useRef(false);
  const applyingRemote = useRef(false);

  useEffect(() => {
    send("getEnhancedUIPreferences", {}, resp => {
      if ("error" in resp) {
        // Older firmware or a transient request failure should not break the UI.
        loaded.current = true;
        return;
      }

      const prefs = resp.result as Partial<DeviceUIPreferences>;
      if (!prefs.configured) {
        // First enhanced build: migrate the user's current browser preference
        // into device storage instead of resetting an existing Chinese/dark UI.
        send(
          "setEnhancedUIPreferences",
          { preferences: { language, theme: themeMode, configured: true } },
          () => {
            loaded.current = true;
          },
        );
        return;
      }

      applyingRemote.current = true;
      if (validLanguage(prefs.language) && prefs.language !== language) {
        setLanguage(prefs.language);
      }
      if (validTheme(prefs.theme) && prefs.theme !== themeMode) {
        setThemeMode(prefs.theme);
      }
      window.setTimeout(() => {
        applyingRemote.current = false;
        loaded.current = true;
      }, 0);
    });
    // This intentionally runs only once after the authenticated device UI mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loaded.current || applyingRemote.current) return;
    const timer = window.setTimeout(() => {
      send("setEnhancedUIPreferences", {
        preferences: {
          language: validLanguage(language) ? language : "en",
          theme: themeMode,
          configured: true,
        },
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [language, themeMode, send]);

  return null;
}
