package gateway

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gpt-load/internal/channel"
	"gpt-load/internal/execution"
	"gpt-load/internal/platform/redact"
	"gpt-load/internal/state"
)

func TestWebsocketProviderErrorsRetainSanitizedSummaries(t *testing.T) {
	const message = "Selected model is at capacity. Please try a different model."
	for _, test := range []struct {
		name      string
		payload   string
		committed bool
		want      string
	}{
		{
			name: "first error",
			payload: fmt.Sprintf(`{"type":"error","status":503,"error":{"code":"server_error","message":%q}}`,
				message+" upstream-key fixture-header-secret"),
			want: message + " " + redact.Placeholder + " " + redact.Placeholder,
		},
		{
			name: "missing message", committed: true,
			payload: `{"type":"error","status":503,"error":{"code":"server_error"}}`,
			want:    "Upstream WebSocket request failed.",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			h, engine, _ := websocketTestHandler(t, "http://127.0.0.1:1", channel.CLIProxyAPI)
			group := h.manager.Current().Groups[1]
			group.HeaderRules = state.HeaderRules{Set: map[string]string{"X-Diagnostic-Secret": "fixture-header-secret"}}
			h.manager.Current().Groups[1] = group
			sink := &recordingRequestLogSink{}
			h.requestLogSink = sink
			h.forwarder = websocketScriptForwarder{AttemptForwarder: h.forwarder, open: func(_ context.Context, _ ForwardInput) (execution.WebsocketSession, execution.WebsocketResult) {
				session := &websocketScriptSession{done: make(chan struct{})}
				session.turn = func(ctx context.Context, _ []byte, emit func(context.Context, []byte) error) execution.WebsocketResult {
					if test.committed {
						if err := emit(ctx, []byte(`{"type":"response.created","response":{"id":"resp_failed","object":"response","status":"in_progress"}}`)); err != nil {
							t.Error(err)
						}
					}
					if err := emit(ctx, []byte(test.payload)); err != nil {
						t.Error(err)
					}
					return execution.WebsocketResult{DispatchState: execution.DispatchMaybeSent, Error: &execution.ErrorEvidence{
						Kind: execution.ErrorKindHTTP, OriginHint: execution.ErrorOriginUpstream,
						StatusCode: http.StatusServiceUnavailable, Code: "server_error", Summary: "WebSocket upstream request failed.",
					}}
				}
				return session, execution.WebsocketResult{DispatchState: execution.DispatchNotSent}
			}}
			server := httptest.NewServer(engine)
			defer server.Close()
			conn := dialGatewayWebsocket(t, server.URL)
			defer conn.Close()
			if err := conn.WriteJSON(map[string]any{"type": "response.create", "model": "public", "input": "test", "store": false}); err != nil {
				t.Fatal(err)
			}
			if test.committed {
				if _, _, err := conn.ReadMessage(); err != nil {
					t.Fatal(err)
				}
			}
			_, body, err := conn.ReadMessage()
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(body), "upstream-key") ||
				(test.name != "missing message" && !strings.Contains(string(body), message)) {
				t.Fatalf("upstream error was lost or credentials leaked: %s", body)
			}
			event := waitWebsocketLogs(t, sink, 1)[0]
			if len(event.Attempts) != 1 || event.StatusCode != http.StatusServiceUnavailable {
				t.Fatalf("unexpected request outcome: %+v", event)
			}
			attempt := event.Attempts[0]
			if event.ErrorSummary != test.want || attempt.ErrorSummary != test.want {
				t.Errorf("summaries = %q / %q, want %q", event.ErrorSummary, attempt.ErrorSummary, test.want)
			}
		})
	}
}
