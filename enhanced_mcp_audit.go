package kvm

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

const (
	mcpAuditPath       = "/userdata/picokvm/mcp-audit.jsonl"
	mcpAuditMaxBytes   = int64(2 * 1024 * 1024)
	mcpAuditRotations  = 3
	mcpAuditMaxPreview = 200
)

type MCPAuditEntry struct {
	Seq         uint64 `json:"seq"`
	Timestamp   string `json:"timestamp"`
	Tool        string `json:"tool"`
	Arguments   any    `json:"arguments,omitempty"`
	DurationMS  int64  `json:"duration_ms"`
	Success     bool   `json:"success"`
	Result      any    `json:"result,omitempty"`
	Error       string `json:"error,omitempty"`
	Manual      bool   `json:"manual_takeover"`
	LocalLocked bool   `json:"local_input_locked"`
}

type MCPAuditSnapshot struct {
	Path    string          `json:"path"`
	Entries []MCPAuditEntry `json:"entries"`
}

type MCPDebugBundle struct {
	Filename string `json:"filename"`
	MIMEType string `json:"mime_type"`
	Base64   string `json:"data_base64"`
}

var mcpAuditState = struct {
	sync.Mutex
	seq uint64
}{}

func rotateMCPAuditLocked() error {
	info, err := os.Stat(mcpAuditPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if info.Size() < mcpAuditMaxBytes {
		return nil
	}
	_ = os.Remove(fmt.Sprintf("%s.%d", mcpAuditPath, mcpAuditRotations))
	for i := mcpAuditRotations - 1; i >= 1; i-- {
		oldPath := fmt.Sprintf("%s.%d", mcpAuditPath, i)
		newPath := fmt.Sprintf("%s.%d", mcpAuditPath, i+1)
		if _, err := os.Stat(oldPath); err == nil {
			_ = os.Rename(oldPath, newPath)
		}
	}
	return os.Rename(mcpAuditPath, mcpAuditPath+".1")
}

func appendMCPAudit(entry MCPAuditEntry) {
	mcpAuditState.Lock()
	defer mcpAuditState.Unlock()
	mcpAuditState.seq++
	entry.Seq = mcpAuditState.seq
	if err := os.MkdirAll(filepath.Dir(mcpAuditPath), 0755); err != nil {
		logger.Warn().Err(err).Msg("failed to create MCP audit directory")
		return
	}
	if err := rotateMCPAuditLocked(); err != nil {
		logger.Warn().Err(err).Msg("failed to rotate MCP audit log")
	}
	data, err := json.Marshal(entry)
	if err != nil {
		logger.Warn().Err(err).Msg("failed to marshal MCP audit entry")
		return
	}
	f, err := os.OpenFile(mcpAuditPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		logger.Warn().Err(err).Msg("failed to open MCP audit log")
		return
	}
	defer f.Close()
	_, _ = f.Write(append(data, '\n'))
}

func auditResult(tool string, result *mcp.CallToolResult) any {
	if result == nil {
		return nil
	}
	// Screenshot image payloads can be hundreds of KiB and provide no useful
	// audit value. Keep metadata while the actual JPEG continues to be returned
	// normally to the MCP client.
	if tool == "capture_screenshot" {
		data, _ := json.Marshal(result)
		return map[string]any{
			"type": "image/jpeg",
			"payload_omitted": true,
			"serialized_result_bytes": len(data),
			"is_error": result.IsError,
		}
	}
	data, err := json.Marshal(result)
	if err != nil {
		return fmt.Sprintf("<result marshal error: %v>", err)
	}
	// Guard against an unexpected gigantic result while preserving complete
	// normal text/JSON tool output.
	if len(data) > 256*1024 {
		return map[string]any{
			"payload_omitted": true,
			"serialized_result_bytes": len(data),
			"is_error": result.IsError,
		}
	}
	var decoded any
	if json.Unmarshal(data, &decoded) == nil {
		return decoded
	}
	return string(data)
}

func mcpAuditMiddleware(next server.ToolHandlerFunc) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		started := time.Now()
		tool := req.Params.Name
		args := req.GetArguments()
		result, err := next(ctx, req)
		control := getEnhancedMCPControlStatus()
		entry := MCPAuditEntry{
			Timestamp: time.Now().Format(time.RFC3339Nano),
			Tool: tool,
			Arguments: args,
			DurationMS: time.Since(started).Milliseconds(),
			Success: err == nil && (result == nil || !result.IsError),
			Result: auditResult(tool, result),
			Manual: control.ManualTakeover,
			LocalLocked: control.LocalInputLocked,
		}
		if err != nil {
			entry.Error = err.Error()
		}
		appendMCPAudit(entry)
		return result, err
	}
}

func readMCPAudit(limit int) MCPAuditSnapshot {
	if limit <= 0 || limit > mcpAuditMaxPreview {
		limit = 100
	}
	entries := make([]MCPAuditEntry, 0, limit)
	f, err := os.Open(mcpAuditPath)
	if err != nil {
		return MCPAuditSnapshot{Path: mcpAuditPath, Entries: entries}
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		var entry MCPAuditEntry
		if json.Unmarshal(scanner.Bytes(), &entry) != nil {
			continue
		}
		entries = append(entries, entry)
		if len(entries) > limit {
			copy(entries, entries[len(entries)-limit:])
			entries = entries[:limit]
		}
	}
	return MCPAuditSnapshot{Path: mcpAuditPath, Entries: entries}
}

func clearMCPAudit() error {
	mcpAuditState.Lock()
	defer mcpAuditState.Unlock()
	for i := 0; i <= mcpAuditRotations; i++ {
		path := mcpAuditPath
		if i > 0 {
			path = fmt.Sprintf("%s.%d", mcpAuditPath, i)
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func addJSONToZip(zw *zip.Writer, name string, value any) {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		data = []byte(fmt.Sprintf("{\"error\":%q}", err.Error()))
	}
	w, err := zw.Create(name)
	if err == nil {
		_, _ = w.Write(data)
	}
}

func createMCPDebugBundle() (MCPDebugBundle, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for i := 0; i <= mcpAuditRotations; i++ {
		path := mcpAuditPath
		name := "mcp-audit.jsonl"
		if i > 0 {
			path = fmt.Sprintf("%s.%d", mcpAuditPath, i)
			name = fmt.Sprintf("mcp-audit.%d.jsonl", i)
		}
		if data, err := os.ReadFile(path); err == nil {
			if w, createErr := zw.Create(name); createErr == nil {
				_, _ = w.Write(data)
			}
		}
	}
	if diagnostics, err := rpcGetEnhancedDiagnostics(); err == nil {
		addJSONToZip(zw, "diagnostics.json", diagnostics)
	} else {
		addJSONToZip(zw, "diagnostics.json", map[string]any{"error": err.Error()})
	}
	addJSONToZip(zw, "mcp-control-status.json", getEnhancedMCPControlStatus())
	addJSONToZip(zw, "hid-status.json", getMCPHIDStatus())
	addJSONToZip(zw, "usb-recovery-status.json", getUSBReinitializeStatus())
	addJSONToZip(zw, "stream-status.json", getEnhancedStreamStatus())
	addJSONToZip(zw, "recording-status.json", getEncodedRecordingStatus())
	addJSONToZip(zw, "supervisor-status.json", getEnhancedSupervisorStatus())
	addJSONToZip(zw, "version.json", map[string]any{"app_version": builtAppVersion, "generated_at": time.Now().Format(time.RFC3339Nano)})
	if err := zw.Close(); err != nil {
		return MCPDebugBundle{}, err
	}
	filename := "picokvm-mcp-debug-" + time.Now().Format("20060102-150405") + ".zip"
	return MCPDebugBundle{Filename: filename, MIMEType: "application/zip", Base64: base64.StdEncoding.EncodeToString(buf.Bytes())}, nil
}

func init() {
	rpcHandlers["getEnhancedMCPAudit"] = RPCHandler{Func: rpcGetEnhancedMCPAudit, Params: []string{"limit"}}
	rpcHandlers["clearEnhancedMCPAudit"] = RPCHandler{Func: rpcClearEnhancedMCPAudit}
	rpcHandlers["downloadEnhancedMCPDebugBundle"] = RPCHandler{Func: rpcDownloadEnhancedMCPDebugBundle}
}

func rpcGetEnhancedMCPAudit(limit int) (MCPAuditSnapshot, error) {
	return readMCPAudit(limit), nil
}

func rpcClearEnhancedMCPAudit() (MCPAuditSnapshot, error) {
	if err := clearMCPAudit(); err != nil {
		return MCPAuditSnapshot{}, err
	}
	return readMCPAudit(100), nil
}

func rpcDownloadEnhancedMCPDebugBundle() (MCPDebugBundle, error) {
	return createMCPDebugBundle()
}
