import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuCornerDownLeft } from "react-icons/lu";
import { ExclamationCircleIcon } from "@heroicons/react/16/solid";
import { useClose } from "@headlessui/react";

import { Button } from "@components/Button";
import { GridCard } from "@components/Card";
import { TextAreaWithLabel } from "@components/TextArea";
import { SettingsPageHeader } from "@components/SettingsPageheader";
import { useJsonRpc } from "@/hooks/useJsonRpc";
import { useHidStore, useRTCStore, useUiStore, useSettingsStore } from "@/hooks/stores";
import { keys, modifiers } from "@/keyboardMappings";
import { layouts, chars } from "@/keyboardLayouts";
import notifications from "@/notifications";
import {useReactAt} from 'i18n-auto-extractor/react'
import { Checkbox } from "@/components/Checkbox";

const hidKeyboardPayload = (keys: number[], modifier: number) => {
  return { keys, modifier };
};

const modifierCode = (shift?: boolean, altRight?: boolean) => {
  return (shift ? modifiers["ShiftLeft"] : 0)
       | (altRight ? modifiers["AltRight"] : 0)
}
const noModifier = 0

export default function PasteModal() {
  const TextAreaRef = useRef<HTMLTextAreaElement>(null);
  const setPasteMode = useHidStore(state => state.setPasteModeEnabled);
  const setDisableVideoFocusTrap = useUiStore(state => state.setDisableVideoFocusTrap);
  const isReinitializingGadget = useHidStore(state => state.isReinitializingGadget);

  const [send] = useJsonRpc();
  const rpcDataChannel = useRTCStore(state => state.rpcDataChannel);

  const [invalidChars, setInvalidChars] = useState<string[]>([]);
  const overrideCtrlV = useSettingsStore(state => state.overrideCtrlV);
  const setOverrideCtrlV = useSettingsStore(state => state.setOverrideCtrlV);
  const [pasteBuffer, setPasteBuffer] = useState<string>("");
  const close = useClose();

  const keyboardLayout = useSettingsStore(state => state.keyboardLayout);
  const setKeyboardLayout = useSettingsStore(
    state => state.setKeyboardLayout,
  );
  const { $at } = useReactAt();

  // this ensures we always get the original en_US if it hasn't been set yet
  const safeKeyboardLayout = useMemo(() => {
    if (keyboardLayout && keyboardLayout.length > 0)
      return keyboardLayout;
    return "en_US";
  }, [keyboardLayout]);

  useEffect(() => {
    send("getKeyboardLayout", {}, resp => {
      if ("error" in resp) return;
      setKeyboardLayout(resp.result as string);
    });
  }, [send, setKeyboardLayout]);

  const onCancelPasteMode = useCallback(() => {
    setPasteMode(false);
    setDisableVideoFocusTrap(false);
    setInvalidChars([]);
    // keep override state persistent via settings store; do not reset here
  }, [setDisableVideoFocusTrap, setPasteMode]);

  const onConfirmPaste = useCallback(async () => {
    setPasteMode(false);
    setDisableVideoFocusTrap(false);
    if (rpcDataChannel?.readyState !== "open" || !TextAreaRef.current) return;
    // Don't send keyboard events while reinitializing gadget
    if (isReinitializingGadget) {
      notifications.error("USB gadget is reinitializing, please wait...");
      return;
    }
    if (!safeKeyboardLayout) return;
    if (!chars[safeKeyboardLayout]) return;
    const text = TextAreaRef.current.value;
    const sendText = async (t: string) => {
      try {
        for (const char of t) {
          const mapping = chars[safeKeyboardLayout][char];
          if (!mapping || !mapping.key) continue;
          const { key, shift, altRight, deadKey, accentKey } = mapping;

          const keyz = [keys[key]];
          const modz = [modifierCode(shift, altRight)];

          if (deadKey) {
            keyz.push(keys["Space"]);
            modz.push(noModifier);
          }
          if (accentKey) {
            keyz.unshift(keys[accentKey.key]);
            modz.unshift(modifierCode(accentKey.shift, accentKey.altRight));
          }

          for (const [index, kei] of keyz.entries()) {
            await new Promise<void>((resolve, reject) => {
              send(
                "keyboardReport",
                hidKeyboardPayload([kei], modz[index]),
                params => {
                  if ("error" in params) return reject(params.error);
                  send("keyboardReport", hidKeyboardPayload([], 0), params => {
                    if ("error" in params) return reject(params.error);
                    resolve();
                  });
                },
              );
            });
          }
        }
        notifications.success(`Pasted: "${t}"`);
      } catch (error) {
        notifications.error("Failed to paste text");
      }
    };

    await sendText(text);
  }, [rpcDataChannel?.readyState, send, setDisableVideoFocusTrap, setPasteMode, safeKeyboardLayout, isReinitializingGadget]);

  const readClipboardToBufferAndSend = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setPasteBuffer(text);
      const segInvalid = [
        ...new Set(
          // @ts-expect-error TS doesn't recognize Intl.Segmenter in some environments
          [...new Intl.Segmenter().segment(text)]
            .map(x => x.segment)
            .filter(char => !chars[safeKeyboardLayout][char]),
        ),
      ];
      setInvalidChars(segInvalid);
      if (segInvalid.length === 0) {
        if (rpcDataChannel?.readyState !== "open" || isReinitializingGadget) return;
        const sendText = async (t: string) => {
          try {
            for (const char of t) {
              const mapping = chars[safeKeyboardLayout][char];
              if (!mapping || !mapping.key) continue;
              const { key, shift, altRight, deadKey, accentKey } = mapping;

              const keyz = [keys[key]];
              const modz = [modifierCode(shift, altRight)];

              if (deadKey) {
                keyz.push(keys["Space"]);
                modz.push(noModifier);
              }
              if (accentKey) {
                keyz.unshift(keys[accentKey.key]);
                modz.unshift(modifierCode(accentKey.shift, accentKey.altRight));
              }

              for (const [index, kei] of keyz.entries()) {
                await new Promise<void>((resolve, reject) => {
                  send(
                    "keyboardReport",
                    hidKeyboardPayload([kei], modz[index]),
                    params => {
                      if ("error" in params) return reject(params.error);
                      send("keyboardReport", hidKeyboardPayload([], 0), params => {
                        if ("error" in params) return reject(params.error);
                        resolve();
                      });
                    },
                  );
                });
              }
            }
            notifications.success(`Pasted: "${t}"`);
          } catch (error) {
            notifications.error("Failed to paste text");
          }
        };
        await sendText(text);
      } else {
        notifications.error(`Invalid characters: ${segInvalid.join(", ")}`);
      }
    } catch {}
  }, [safeKeyboardLayout, rpcDataChannel?.readyState, isReinitializingGadget, send]);

  useEffect(() => {
    if (TextAreaRef.current) {
      TextAreaRef.current.focus();
    }
  }, []);

  return (
    <GridCard>
      <div className="space-y-4 p-4 py-3">
        <div className="grid h-full grid-rows-(--grid-headerBody)">
          <div className="h-full space-y-4">
            <div className="space-y-4">
              <SettingsPageHeader
                title={$at("Paste text")}
                description={$at("Paste text from your client to the remote host")}
              />

              <div className="flex items-center">
                <label className="flex items-center gap-x-2 text-sm">
                  <Checkbox
                    checked={overrideCtrlV}
                    onChange={e => setOverrideCtrlV(e.target.checked)}
                  />
                  <span className="text-slate-700 dark:text-slate-300">
                    {$at("Use Ctrl+V to paste clipboard to remote")}
                  </span>
                </label>
              </div>
              
              <div
                className="animate-fadeIn opacity-0 space-y-2"
                style={{
                  animationDuration: "0.7s",
                  animationDelay: "0.1s",
                }}
              >
                <div>
                  <div
                    className="w-full"
                    onKeyUp={e => e.stopPropagation()}
                    onKeyDown={e => {
                      e.stopPropagation();
                      if (overrideCtrlV && (e.key.toLowerCase() === "v" || e.code === "KeyV") && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        readClipboardToBufferAndSend();
                      }
                    }}
                    onPaste={e => {
                      if (overrideCtrlV) {
                        e.preventDefault();
                        const txt = e.clipboardData?.getData("text") || "";
                        if (txt) {
                          setPasteBuffer(txt);
                          const segInvalid = [
                            ...new Set(
                              // @ts-expect-error TS doesn't recognize Intl.Segmenter in some environments
                              [...new Intl.Segmenter().segment(txt)]
                                .map(x => x.segment)
                                .filter(char => !chars[safeKeyboardLayout][char]),
                            ),
                          ];
                          setInvalidChars(segInvalid);
                          if (segInvalid.length === 0) {
                            if (rpcDataChannel?.readyState === "open" && !isReinitializingGadget) {
                              const sendText = async (t: string) => {
                                try {
                                  for (const char of t) {
                                    const mapping = chars[safeKeyboardLayout][char];
                                    if (!mapping || !mapping.key) continue;
                                    const { key, shift, altRight, deadKey, accentKey } = mapping;
                                    const keyz = [keys[key]];
                                    const modz = [modifierCode(shift, altRight)];
                                    if (deadKey) {
                                      keyz.push(keys["Space"]);
                                      modz.push(noModifier);
                                    }
                                    if (accentKey) {
                                      keyz.unshift(keys[accentKey.key]);
                                      modz.unshift(modifierCode(accentKey.shift, accentKey.altRight));
                                    }
                                    for (const [index, kei] of keyz.entries()) {
                                      await new Promise<void>((resolve, reject) => {
                                        send(
                                          "keyboardReport",
                                          hidKeyboardPayload([kei], modz[index]),
                                          params => {
                                            if ("error" in params) return reject(params.error);
                                            send("keyboardReport", hidKeyboardPayload([], 0), params => {
                                              if ("error" in params) return reject(params.error);
                                              resolve();
                                            });
                                          },
                                        );
                                      });
                                    }
                                  }
                                  notifications.success(`Pasted: "${t}"`);
                                } catch (error) {
                                  notifications.error("Failed to paste text");
                                }
                              };
                              sendText(txt);
                            }
                          } else {
                            notifications.error(`Invalid characters: ${segInvalid.join(", ")}`);
                          }
                        } else {
                          readClipboardToBufferAndSend();
                        }
                      }
                    }}
                  >
                    {!overrideCtrlV && (
                      <>
                        <TextAreaWithLabel
                          ref={TextAreaRef}
                          label={$at("Paste from host")}
                          rows={4}
                          onKeyUp={e => e.stopPropagation()}
                          onKeyDown={e => {
                            e.stopPropagation();
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                              e.preventDefault();
                              onConfirmPaste();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              onCancelPasteMode();
                            }
                          }}
                          onChange={e => {
                            const value = e.target.value;
                            const invalidChars = [
                              ...new Set(
                                // @ts-expect-error TS doesn't recognize Intl.Segmenter in some environments
                                [...new Intl.Segmenter().segment(value)]
                                  .map(x => x.segment)
                                  .filter(char => !chars[safeKeyboardLayout][char]),
                              ),
                            ];

                            setInvalidChars(invalidChars);
                          }}
                        />

                        {invalidChars.length > 0 && (
                          <div className="mt-2 flex items-center gap-x-2">
                            <ExclamationCircleIcon className="h-4 w-4 text-red-500 dark:text-red-400" />
                            <span className="text-xs text-red-500 dark:text-red-400">
                              {$at("The following characters will not be pasted:")} {invalidChars.join(", ")}
                            </span>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <div className="space-y-4">
                  <p className="text-xs text-slate-600 dark:text-slate-400">
                    {$at("Sending text using keyboard layout:")} {layouts[safeKeyboardLayout]}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div
          className="flex animate-fadeIn opacity-0 items-center justify-end gap-x-2"
          style={{
            animationDuration: "0.7s",
            animationDelay: "0.2s",
          }}
        >
          <Button
            size="SM"
            theme="blank"
            text={$at("Cancel")}
            onClick={() => {
              onCancelPasteMode();
              close();
            }}
          />
          {!overrideCtrlV && (
            <Button
              size="SM"
              theme="primary"
              text={$at("Confirm paste")}
              onClick={onConfirmPaste}
              LeadingIcon={LuCornerDownLeft}
            />
          )}
        </div>
      </div>
    </GridCard>
  );
}
