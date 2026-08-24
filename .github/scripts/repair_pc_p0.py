from __future__ import annotations

from pathlib import Path
import subprocess

BASE_PC_COMMIT = "4919a3e88b8245d7fb3c8fb13a1bdf04526a6696"
PC_PATH = Path("ui/src/layout/index.pc.tsx")
MOBILE_PATH = Path("ui/src/layout/index.mobile.tsx")
WEB_PATH = Path("web.go")


def require_replace(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"anchor not found: {label}")
    return text.replace(old, new, 1)


def git_show(commit: str, path: str) -> str:
    return subprocess.check_output(
        ["git", "show", f"{commit}:{path}"], text=True, encoding="utf-8"
    )


# Rebuild the PC layout from the last known-good complete source, then copy the
# already-validated mobile signaling implementation. This avoids carrying the
# truncated/corrupted PC source from the previous transport attempt.
pc = git_show(BASE_PC_COMMIT, PC_PATH.as_posix())
mobile = MOBILE_PATH.read_text(encoding="utf-8")

start_marker = '  const [loadingMessage, setLoadingMessage] = useState("Connecting to device...");'
end_marker = "  // Cleanup effect"

mobile_start = mobile.index(start_marker)
mobile_end = mobile.index(end_marker, mobile_start)
pc_start = pc.index(start_marker)
pc_end = pc.index(end_marker, pc_start)

pc = pc[:pc_start] + mobile[mobile_start:mobile_end] + pc[pc_end:]

pc = require_replace(
    pc,
    "  const sidebarView = useUiStore(state => state.sidebarView);\n",
    "  const sidebarView = useUiStore(state => state.sidebarView);\n"
    "  const topBarView = useUiStore(state => state.topBarView);\n",
    "PC top-bar view hook",
)

pc = require_replace(
    pc,
    '    if (resp.method === "otherSessionConnected") {\n      navigateTo("/other-session");\n    }',
    '    if (resp.method === "otherSessionConnected") {\n'
    '      takeoverNoticeRef.current = true;\n'
    '      navigateTo("/other-session");\n'
    '    }',
    "PC takeover notice",
)

pc = require_replace(
    pc,
    '    if (resp.method === "sessionInvalidated") {\n      resetHttpSessionId();',
    '    if (resp.method === "sessionInvalidated") {\n'
    '      takeoverNoticeRef.current = true;\n'
    '      resetHttpSessionId();',
    "PC session invalidation guard",
)

pc = require_replace(
    pc,
    '    const isOtherSession = location.pathname.includes("other-session");\n\n'
    '    if (isOtherSession) return null;',
    '    const isOtherSession = location.pathname.includes("other-session");\n\n'
    '    // Keep settings/top-bar controls usable while transport is down. The\n'
    '    // connection overlay belongs to the video viewport, never the whole app.\n'
    '    if (sidebarView || topBarView) return null;\n'
    '    if (isOtherSession) return null;',
    "PC management UI overlay isolation",
)

pc = require_replace(
    pc,
    "    connectionFailed,\n    loadingMessage,\n    location.pathname,\n    peerConnection,\n    peerConnectionState,\n    setupPeerConnection,\n  ]);",
    "    connectionFailed,\n    forceHttp,\n    loadingMessage,\n    location.pathname,\n"
    "    peerConnection,\n    peerConnectionState,\n    setupPeerConnection,\n"
    "    sidebarView,\n    topBarView,\n  ]);",
    "PC connection overlay dependencies",
)

old_desktop = '''            <Desktop isFullscreen={isFullscreen} />
            <div
              style={{ animationDuration: "500ms" }}
              className="animate-slideUpFade pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
            >
              <div className="relative h-full w-full">
                {!!ConnectionStatusElement && ConnectionStatusElement}
                {/*<ConnectionFailedOverlay show={true} setupPeerConnection={setupPeerConnection} />*/}
              </div>
            </div>

            <SidebarContainer sidebarView={sidebarView} />'''
new_desktop = '''            <Desktop
              isFullscreen={isFullscreen}
              connectionOverlay={ConnectionStatusElement}
            />

            <SidebarContainer sidebarView={sidebarView} />'''
pc = require_replace(pc, old_desktop, new_desktop, "PC structural video overlay")

if "console.error(return" in pc:
    raise RuntimeError("corrupted PC syntax survived deterministic rebuild")
if not pc.rstrip().endswith("}"):
    raise RuntimeError("PC source is unexpectedly truncated")
PC_PATH.write_text(pc, encoding="utf-8")

# HTTP fallback polling is observer traffic. Read-only calls must not steal the
# single controller lease from a healthy WebRTC tab; explicit takeover and
# state-changing HTTP RPCs still participate in session arbitration.
web = WEB_PATH.read_text(encoding="utf-8")
helper = '''func isReadOnlyHTTPSessionRPC(method string) bool {
	return strings.HasPrefix(method, "get") ||
		strings.HasPrefix(method, "list") ||
		strings.HasPrefix(method, "download")
}

'''
if "func isReadOnlyHTTPSessionRPC(" not in web:
    web = require_replace(
        web,
        "func handleRpcRequest(c *gin.Context) {\n",
        helper + "func handleRpcRequest(c *gin.Context) {\n",
        "HTTP read-only observer helper",
    )

if "readOnlyObserver := isReadOnlyHTTPSessionRPC(req.Method)" not in web:
    web = require_replace(
        web,
        '\tif req.Method == "confirmOtherSession" {\n',
        '\treadOnlyObserver := isReadOnlyHTTPSessionRPC(req.Method)\n\n'
        '\tif req.Method == "confirmOtherSession" {\n',
        "HTTP observer classification",
    )

web = require_replace(
    web,
    '\t\t//\tMsg("handleRpcRequest confirmOtherSession")\n\t} else {\n',
    '\t\t//\tMsg("handleRpcRequest confirmOtherSession")\n'
    '\t} else if !readOnlyObserver {\n',
    "HTTP observer arbitration bypass",
)
WEB_PATH.write_text(web, encoding="utf-8")
subprocess.run(["gofmt", "-w", WEB_PATH.as_posix()], check=True)

# Touch marker: the workflow already exists on enhanced/dev; this commit exists
# only to emit a fresh push event for the deterministic repair job.
print("P0 repair complete")
print(f"PC bytes: {PC_PATH.stat().st_size}")
print(f"Web bytes: {WEB_PATH.stat().st_size}")