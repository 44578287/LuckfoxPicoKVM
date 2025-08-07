import React, { useEffect, useState } from "react";
import { LuVolume2, LuVolumeX } from "react-icons/lu";
import clsx from "clsx";
import { cva, cx } from "@/cva.config";

interface VolumeControlProps {
  theme?: "primary" | "danger" | "light" | "lightDanger" | "blank";
  size?: "XS" | "SM" | "MD" | "LG" | "XL";
  fullWidth?: boolean;
  className?: string;
}

const sizes = {
  XS: "h-[28px] px-2 text-xs",
  SM: "h-[36px] px-3 text-[13px]",
  MD: "h-[40px] px-3.5 text-sm",
  LG: "h-[48px] px-4 text-base",
  XL: "h-[56px] px-5 text-base",
};

const themes = {
  primary: cx(
    // Base styles
    "bg-blue-700 dark:border-blue-600 border border-blue-900/60 text-white shadow-sm",
    // Hover states
    "group-hover:bg-blue-800",
    // Active states
    "group-active:bg-blue-900",
  ),
  danger: cx(
    // Base styles
    "bg-red-600 text-white border-red-700 shadow-xs shadow-red-200/80 dark:border-red-600 dark:shadow-red-900/20",
    // Hover states
    "group-hover:bg-red-700 group-hover:border-red-800 dark:group-hover:bg-red-700 dark:group-hover:border-red-600",
    // Active states
    "group-active:bg-red-800 dark:group-active:bg-red-800",
    // Focus states
    "group-focus:ring-red-700 dark:group-focus:ring-red-600",
  ),
  light: cx(
    // Base styles
    "bg-white text-black border-slate-800/30 shadow-xs dark:bg-slate-800 dark:border-slate-300/20 dark:text-white",
    // Hover states
    "group-hover:bg-blue-50/80 dark:group-hover:bg-slate-700",
    // Active states
    "group-active:bg-blue-100/60 dark:group-active:bg-slate-600",
    // Disabled states
    "group-disabled:group-hover:bg-white dark:group-disabled:group-hover:bg-slate-800",
  ),
  lightDanger: cx(
    // Base styles
    "bg-white text-black border-red-400/60 shadow-xs",
    // Hover states
    "group-hover:bg-red-50/80",
    // Active states
    "group-active:bg-red-100/60",
    // Focus states
    "group-focus:ring-red-700",
  ),
  blank: cx(
    // Base styles
    "bg-white/0 text-black border-transparent dark:text-white",
    // Hover states
    "group-hover:bg-white group-hover:border-slate-800/30 group-hover:shadow-sm dark:group-hover:bg-slate-700 dark:group-hover:border-slate-600",
    // Active states
    "group-active:bg-slate-100/80",
  ),
};

const btnVariants = cva({
  base: cx(
    // Base styles
    "border rounded-sm select-none",
    // Size classes
    "justify-center items-center shrink-0",
    // Transition classes
    "outline-hidden transition-all duration-200",
    // Text classes
    "font-display text-center font-medium leading-tight",
    // States
    "group-focus:outline-hidden group-focus:ring-2 group-focus:ring-offset-2 group-focus:ring-blue-700",
    "group-disabled:opacity-50 group-disabled:pointer-events-none",
  ),

  variants: {
    size: sizes,
    theme: themes,
  },
});

const iconVariants = cva({
  variants: {
    size: {
      XS: "h-3.5",
      SM: "h-3.5",
      MD: "h-5",
      LG: "h-6",
      XL: "h-6",
    },
    theme: {
      primary: "text-white",
      danger: "text-white ",
      light: "text-black dark:text-white",
      lightDanger: "text-black dark:text-white",
      blank: "text-black dark:text-white",
    },
  },
});

const VolumeControl: React.FC<VolumeControlProps> = ({
  theme = "light",
  size = "XS",
  fullWidth = false,
  className,
}) => {
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(true);
  const [showSlider, setShowSlider] = useState(false);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = document.querySelector("audio#global-audio") as HTMLAudioElement | null;
    setAudioElement(audio);
    if (audio) {
      const savedVolume = parseFloat(localStorage.getItem("audioVolume") || "1");
      const savedMuted = localStorage.getItem("audioMuted") === "true";
      
      audio.volume = savedVolume;
      audio.muted = savedMuted;
      setVolume(savedVolume);
      setMuted(savedMuted);

      audio
        .play()
        .catch(() => {
          audio.muted = true;
          setMuted(true);
        });
    }
  }, []);

  const handlePlay = () => {
    if (!audioElement) return;
    audioElement.muted = false;
    audioElement.volume = volume;
    audioElement.play().catch((err) => {
      console.warn("Failed to play:", err);
    });
    setMuted(false);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    setMuted(newVolume === 0);
    if (audioElement) {
      audioElement.volume = newVolume;
      audioElement.muted = newVolume === 0;
    }
    localStorage.setItem("audioVolume", String(newVolume));
    localStorage.setItem("audioMuted", String(newVolume === 0));
  };

  const iconClass = iconVariants({ theme, size });
  const btnClass = btnVariants({ theme, size });

  return (
    <div
      className={clsx(
        "relative group flex items-center gap-2",
        fullWidth ? "w-full" : "w-fit",
        className
      )}
      onMouseEnter={() => setShowSlider(true)}
      onMouseLeave={() => setShowSlider(false)}
    >
      <button
        onClick={handlePlay}
        className={clsx("group p-2 flex items-center", btnClass)}
        aria-label="Unmute & Play"
      >
        {muted || volume === 0 ? (
          <LuVolumeX className={clsx(iconClass, "shrink-0")} />
        ) : (
          <LuVolume2 className={clsx(iconClass, "shrink-0")} />
        )}
      </button>

      <div
        className={clsx(
          "transition-all duration-300 ease-in-out",
          showSlider ? "w-16 opacity-100 ml-2" : "w-0 opacity-0"
        )}
      >
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={muted ? 0 : volume}
          onChange={handleVolumeChange}
          className="w-16 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700"
          aria-label="Volume slider"
        />
      </div>
    </div>
  );
};

export default VolumeControl;