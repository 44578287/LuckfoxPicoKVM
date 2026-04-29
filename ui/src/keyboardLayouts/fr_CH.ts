import { KeyboardLayout, KeyCombo } from "../keyboardLayouts"
import { chars as chars_de_CH } from "./de_CH"
import { modifierDisplayMap, keyDisplayMap, virtualKeyboard } from "./en_US"

const name = "Français de Suisse";
const isoCode = "fr-CH";

export const chars = {
  ...chars_de_CH,
  "è": { key: "BracketLeft" },
  "ü": { key: "BracketLeft", shift: true },
  "é": { key: "Semicolon" },
  "ö": { key: "Semicolon", shift: true },
  "à": { key: "Quote" },
  "ä": { key: "Quote", shift: true },
} as Record<string, KeyCombo>;

export const fr_CH: KeyboardLayout = {
  isoCode,
  name,
  chars,
  keyDisplayMap,
  modifierDisplayMap,
  virtualKeyboard,
};
