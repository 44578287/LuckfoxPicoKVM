from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"anchor not found: {label}")
    return text.replace(old, new, 1)


def patch_layout(path: Path) -> None:
    src = path.read_text(encoding="utf-8")

    src = replace_once(
        src,
        "  const takeoverNoticeRef = useRef(false);\n"
        "  const setupPeerConnectionRef = useRef<() => Promise<void>>(async () => undefined);\n",
        "  const takeoverNoticeRef = useRef(false);\n"
        "  // A page parked on /other-session must never reclaim the controller just\n"
        "  // because it was refreshed. Only the explicit Use Here action is allowed\n"
        "  // to bypass that route guard for one PeerConnection setup.\n"
        "  const explicitTakeoverRef = useRef(false);\n"
        "  const setupPeerConnectionRef = useRef<() => Promise<void>>(async () => undefined);\n",
        f"{path.name} explicit takeover ref",
    )

    src = replace_once(
        src,
        "  const setupPeerConnection = useCallback(async () => {\n"
        "    if (useSettingsStore.getState().forceHttp) {\n",
        "  const setupPeerConnection = useCallback(async () => {\n"
        "    const onTakeoverRoute = window.location.pathname.includes(\"/other-session\");\n"
        "    if (onTakeoverRoute && !explicitTakeoverRef.current) {\n"
        "      takeoverNoticeRef.current = true;\n"
        "      clearConnectionWatchdog();\n"
        "      setConnectionFailed(false);\n"
        "      setLoadingMessage(\"Waiting for takeover confirmation...\");\n"
        "      console.log(\"[setupPeerConnection] Suppressed automatic controller setup on /other-session\");\n"
        "      return;\n"
        "    }\n"
        "\n"
        "    // Consume the human authorization exactly once. Any later signaling\n"
        "    // metadata/reconnect while still on the takeover route is suppressed.\n"
        "    explicitTakeoverRef.current = false;\n"
        "\n"
        "    if (useSettingsStore.getState().forceHttp) {\n",
        f"{path.name} takeover route setup guard",
    )

    src = replace_once(
        src,
        "  setupPeerConnectionRef.current = setupPeerConnection;\n\n"
        "  useEffect(() => {\n",
        "  setupPeerConnectionRef.current = setupPeerConnection;\n\n"
        "  const setupPeerConnectionFromTakeover = useCallback(async () => {\n"
        "    explicitTakeoverRef.current = true;\n"
        "    try {\n"
        "      await setupPeerConnection();\n"
        "    } finally {\n"
        "      explicitTakeoverRef.current = false;\n"
        "    }\n"
        "  }, [setupPeerConnection]);\n\n"
        "  useEffect(() => {\n",
        f"{path.name} explicit takeover wrapper",
    )

    src = replace_once(
        src,
        "          <Outlet context={{ setupPeerConnection }} />",
        "          <Outlet context={{ setupPeerConnection: setupPeerConnectionFromTakeover }} />",
        f"{path.name} outlet takeover wrapper",
    )

    path.write_text(src, encoding="utf-8")


for layout in (
    Path("ui/src/layout/index.pc.tsx"),
    Path("ui/src/layout/index.mobile.tsx"),
):
    patch_layout(layout)

print("refresh/takeover route repair complete")
