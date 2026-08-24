package kvm

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/mark3labs/mcp-go/mcp"
)

type MCPTextInjectionStatus struct {
	ID         string `json:"id,omitempty"`
	State      string `json:"state"`
	Characters int    `json:"characters"`
	Sent       int    `json:"sent"`
	Profile    string `json:"profile,omitempty"`
	StartedAt  string `json:"started_at,omitempty"`
	FinishedAt string `json:"finished_at,omitempty"`
	ElapsedMs  int64  `json:"elapsed_ms,omitempty"`
	Error      string `json:"error,omitempty"`
}

var mcpTextTask = struct {
	sync.Mutex
	status MCPTextInjectionStatus
	cancel context.CancelFunc
}{status: MCPTextInjectionStatus{State: "idle"}}

func validateAsyncTextPayload(text string) (string, int, error) {
	text = normalizeReliableText(text)
	if !utf8.ValidString(text) {
		return "", 0, fmt.Errorf("text is not valid UTF-8")
	}
	count := utf8.RuneCountInString(text)
	if count == 0 {
		return "", 0, fmt.Errorf("text is empty")
	}
	if count > 32768 {
		return "", 0, fmt.Errorf("text exceeds the 32768-character reliable injection limit")
	}
	for _, r := range text {
		if r > 0x7f {
			return "", 0, fmt.Errorf("non-ASCII character %q (U+%04X) requires a host clipboard/IME agent", r, r)
		}
		if _, _, err := mcpASCIIReportV2(r); err != nil {
			return "", 0, err
		}
	}
	if state := rpcGetUSBState(); state != "configured" {
		return "", 0, fmt.Errorf("USB gadget is not configured (state=%s)", state)
	}
	return text, count, nil
}

func getMCPTextInjectionStatus() MCPTextInjectionStatus {
	mcpTextTask.Lock()
	defer mcpTextTask.Unlock()
	return mcpTextTask.status
}

func startMCPTextInjection(text string, opts reliableTextOptions, profile string) (MCPTextInjectionStatus, error) {
	normalized, count, err := validateAsyncTextPayload(text)
	if err != nil {
		return MCPTextInjectionStatus{}, err
	}

	mcpTextTask.Lock()
	if mcpTextTask.status.State == "running" {
		st := mcpTextTask.status
		mcpTextTask.Unlock()
		return MCPTextInjectionStatus{}, fmt.Errorf("text injection task %s is already running", st.ID)
	}
	ctx, cancel := context.WithCancel(context.Background())
	now := time.Now()
	st := MCPTextInjectionStatus{
		ID: fmt.Sprintf("text-%d", now.UnixNano()), State: "running",
		Characters: count, Profile: profile, StartedAt: now.Format(time.RFC3339Nano),
	}
	mcpTextTask.status = st
	mcpTextTask.cancel = cancel
	mcpTextTask.Unlock()

	go func(initial MCPTextInjectionStatus) {
		sent, elapsed, runErr := runReliableTextInjectionV2(ctx, normalized, opts)
		mcpTextTask.Lock()
		defer mcpTextTask.Unlock()
		if mcpTextTask.status.ID != initial.ID {
			return
		}
		final := mcpTextTask.status
		final.Sent = sent
		final.ElapsedMs = elapsed.Milliseconds()
		final.FinishedAt = time.Now().Format(time.RFC3339Nano)
		if runErr != nil {
			if ctx.Err() != nil {
				final.State = "cancelled"
			} else {
				final.State = "failed"
			}
			final.Error = runErr.Error()
		} else {
			final.State = "succeeded"
		}
		mcpTextTask.status = final
		mcpTextTask.cancel = nil
	}(st)

	return st, nil
}

func handleInjectTextAsync(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	text, ok := req.GetArguments()["text"].(string)
	if !ok {
		return nil, fmt.Errorf("text is required")
	}
	opts, err := reliableTextOptionsFromArgs(req.GetArguments())
	if err != nil {
		return nil, err
	}
	profile := strings.ToLower(strings.TrimSpace(req.GetString("profile", "normal")))
	if profile == "" {
		profile = "normal"
	}
	st, err := startMCPTextInjection(text, opts, profile)
	if err != nil {
		return nil, err
	}
	data, _ := json.MarshalIndent(st, "", "  ")
	return mcp.NewToolResultText(string(data) + "\nText injection continues on PicoKVM; poll get_text_injection_status until state is succeeded/failed/cancelled."), nil
}

func handleGetTextInjectionStatus(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(getMCPTextInjectionStatus(), "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleCancelTextInjection(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mcpTextTask.Lock()
	if mcpTextTask.status.State != "running" || mcpTextTask.cancel == nil {
		st := mcpTextTask.status
		mcpTextTask.Unlock()
		data, _ := json.MarshalIndent(st, "", "  ")
		return mcp.NewToolResultText("No running text injection task.\n" + string(data)), nil
	}
	cancel := mcpTextTask.cancel
	id := mcpTextTask.status.ID
	mcpTextTask.Unlock()
	cancel()
	return mcp.NewToolResultText(fmt.Sprintf("Cancellation requested for text injection task %s", id)), nil
}
