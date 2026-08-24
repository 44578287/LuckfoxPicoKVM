import { useEffect } from "react";
import { Select } from "antd";
import { useReactAt } from 'i18n-auto-extractor/react';
import { isMobile } from "react-device-detect";

import { SettingsPageHeader } from "@components/Settings/SettingsPageheader";
import { useSettingsStore } from "@/hooks/stores";
import { SettingsItem } from "@components/Settings/SettingsView";
import enJSON from '@/locales/en.json';
import zhJSON from '@/locales/zh.json';
import { ThemeMode, useTheme } from "@/layout/contexts/ThemeContext";
import { dark_font_style } from "@/layout/theme_color";

const { Option } = Select;

export default function SettingsGeneral() {
  const { $at, setCurrentLang } = useReactAt();
  const { themeMode, setThemeMode } = useTheme();
  const language = useSettingsStore(state => state.language);
  const setLanguage = useSettingsStore(state => state.setLanguage);

  const handleLanguageChange = (value: string) => {
    setLanguage(value);
    setCurrentLang(value, value === 'en' ? enJSON : zhJSON);
  };

  useEffect(() => {
    setCurrentLang(language, language === 'en' ? enJSON : zhJSON);
  }, [language, setCurrentLang]);

  const handleThemeChange = (value: string) => {
    setThemeMode(value as ThemeMode);
  };

  return (
    <div className="space-y-4 pb-[50px] text-slate-900 dark:text-slate-100">
      <SettingsPageHeader
        title={$at("General")}
        description={$at("Configure device settings and update preferences")}
      />
      <div className="space-y-4">
        <SettingsItem
          title={$at("Theme")}
          description={$at("Choose your preferred color theme")}
          className={`${isMobile ? "w-full flex-col" : ""}`}
        >
          <div className={`space-y-2 ${isMobile ? "w-full" : "w-[37%]"}`}>
            <Select
              value={themeMode}
              onChange={handleThemeChange}
              className="!h-[36px] !w-full"
            >
              <Option value="light" className={dark_font_style}>{$at('Light')}</Option>
              <Option value="dark" className={dark_font_style}>{$at('Dark')}</Option>
            </Select>
          </div>
        </SettingsItem>
      </div>

      <div className="space-y-4">
        <SettingsItem
          title={$at("Language")}
          description={$at("Choose your language")}
          className={`${isMobile ? "w-full flex-col" : ""}`}
        >
          <div className={`space-y-2 ${isMobile ? "w-full" : "w-[37%]"}`}>
            <Select
              value={language}
              onChange={handleLanguageChange}
              className="!h-[36px] !w-full"
            >
              <Option value="en" className={dark_font_style}>{$at('English')}</Option>
              <Option value="zh" className={dark_font_style}>{$at('中文')}</Option>
            </Select>
          </div>
        </SettingsItem>
      </div>
    </div>
  );
}
