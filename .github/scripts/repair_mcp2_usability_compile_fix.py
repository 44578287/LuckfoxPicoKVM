from pathlib import Path

path = Path("mcp_usability_v2.go")
src = path.read_text(encoding="utf-8")
old = '\t"fmt"\n'
if old not in src:
    raise RuntimeError("MCP 2.0 fmt import anchor missing")
path.write_text(src.replace(old, "", 1), encoding="utf-8")
print("MCP 2.0 compile fix applied")
