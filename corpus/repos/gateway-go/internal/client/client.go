// Package client is a Go client for the gateway's admin API. gatewayctl uses it.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/relaywork/gateway/internal/model"
)

// maxResponseBytes bounds the responses the client reads.
const maxResponseBytes = 8 << 20

// APIError is an error response from the admin API.
type APIError struct {
	Status    int
	Code      string             `json:"code"`
	Message   string             `json:"message"`
	Fields    []model.FieldError `json:"fields"`
	Details   []string           `json:"details"`
	RequestID string             `json:"request_id"`
}

func (e *APIError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%d %s: %s", e.Status, e.Code, e.Message)
	for _, f := range e.Fields {
		fmt.Fprintf(&b, "; %s: %s", f.Field, f.Message)
	}
	for _, d := range e.Details {
		b.WriteString("; " + d)
	}
	return b.String()
}

// Is lets errors.Is match an APIError against the model's error values.
func (e *APIError) Is(target error) bool {
	switch target {
	case model.ErrNotFound:
		return e.Status == http.StatusNotFound
	case model.ErrConflict:
		return e.Status == http.StatusConflict
	}
	return false
}

// Client calls the admin API.
type Client struct {
	base  *url.URL
	token string
	http  *http.Client
}

// New returns a client for the admin API at baseURL, such as "http://127.0.0.1:9090".
func New(baseURL, token string, httpClient *http.Client) (*Client, error) {
	u, err := url.Parse(baseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("client: base URL must be an absolute http or https URL, got %q", baseURL)
	}
	if token == "" {
		return nil, errors.New("client: admin token is required")
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{base: u, token: token, http: httpClient}, nil
}

// ConsumerPage is one page of consumers.
type ConsumerPage struct {
	Consumers []model.Consumer `json:"consumers"`
	Total     int              `json:"total"`
	Offset    int              `json:"offset"`
	Limit     int              `json:"limit"`
}

// IssuedKey is a newly issued API key; Key is shown only this once.
type IssuedKey struct {
	Key    string       `json:"key"`
	APIKey model.APIKey `json:"api_key"`
}

// CreatedSecret is a newly created HMAC secret; Secret is shown only this once.
type CreatedSecret struct {
	KeyID      string               `json:"key_id"`
	Secret     string               `json:"secret"`
	Credential model.HMACCredential `json:"credential"`
}

// CreateConsumer creates a consumer.
func (c *Client) CreateConsumer(ctx context.Context, name string, enabled bool) (model.Consumer, error) {
	var out model.Consumer
	err := c.do(ctx, http.MethodPost, "/admin/v1/consumers", nil, map[string]any{"name": name, "enabled": enabled}, &out)
	return out, err
}

// ListConsumers returns a page of consumers.
func (c *Client) ListConsumers(ctx context.Context, offset, limit int) (ConsumerPage, error) {
	q := url.Values{}
	q.Set("offset", strconv.Itoa(offset))
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	var out ConsumerPage
	err := c.do(ctx, http.MethodGet, "/admin/v1/consumers", q, nil, &out)
	return out, err
}

// GetConsumer returns one consumer.
func (c *Client) GetConsumer(ctx context.Context, id string) (model.Consumer, error) {
	var out model.Consumer
	err := c.do(ctx, http.MethodGet, "/admin/v1/consumers/"+url.PathEscape(id), nil, nil, &out)
	return out, err
}

// UpdateConsumer renames, enables or disables a consumer; nil fields are left as they are.
func (c *Client) UpdateConsumer(ctx context.Context, id string, name *string, enabled *bool) (model.Consumer, error) {
	body := map[string]any{}
	if name != nil {
		body["name"] = *name
	}
	if enabled != nil {
		body["enabled"] = *enabled
	}
	var out model.Consumer
	err := c.do(ctx, http.MethodPatch, "/admin/v1/consumers/"+url.PathEscape(id), nil, body, &out)
	return out, err
}

// DeleteConsumer deletes a consumer and its credentials.
func (c *Client) DeleteConsumer(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/admin/v1/consumers/"+url.PathEscape(id), nil, nil, nil)
}

// IssueKey issues an API key for a consumer.
func (c *Client) IssueKey(ctx context.Context, consumerID string) (IssuedKey, error) {
	var out IssuedKey
	err := c.do(ctx, http.MethodPost, "/admin/v1/consumers/"+url.PathEscape(consumerID)+"/keys", nil, nil, &out)
	return out, err
}

// ListKeys lists a consumer's API keys.
func (c *Client) ListKeys(ctx context.Context, consumerID string) ([]model.APIKey, error) {
	var out struct {
		Keys []model.APIKey `json:"keys"`
	}
	err := c.do(ctx, http.MethodGet, "/admin/v1/consumers/"+url.PathEscape(consumerID)+"/keys", nil, nil, &out)
	return out.Keys, err
}

// RevokeKey revokes a consumer's API key by prefix.
func (c *Client) RevokeKey(ctx context.Context, consumerID, prefix string) error {
	return c.do(ctx, http.MethodDelete,
		"/admin/v1/consumers/"+url.PathEscape(consumerID)+"/keys/"+url.PathEscape(prefix), nil, nil, nil)
}

// CreateHMACSecret creates an HMAC secret for a consumer.
func (c *Client) CreateHMACSecret(ctx context.Context, consumerID string) (CreatedSecret, error) {
	var out CreatedSecret
	err := c.do(ctx, http.MethodPost, "/admin/v1/consumers/"+url.PathEscape(consumerID)+"/hmac-secrets", nil, nil, &out)
	return out, err
}

// ListHMACSecrets lists a consumer's HMAC credentials, without secrets.
func (c *Client) ListHMACSecrets(ctx context.Context, consumerID string) ([]model.HMACCredential, error) {
	var out struct {
		Secrets []model.HMACCredential `json:"hmac_secrets"`
	}
	err := c.do(ctx, http.MethodGet, "/admin/v1/consumers/"+url.PathEscape(consumerID)+"/hmac-secrets", nil, nil, &out)
	return out.Secrets, err
}

// RevokeHMACSecret revokes a consumer's HMAC secret by key id.
func (c *Client) RevokeHMACSecret(ctx context.Context, consumerID, keyID string) error {
	return c.do(ctx, http.MethodDelete,
		"/admin/v1/consumers/"+url.PathEscape(consumerID)+"/hmac-secrets/"+url.PathEscape(keyID), nil, nil, nil)
}

// Routes returns the live routes as the gateway reports them.
func (c *Client) Routes(ctx context.Context) ([]json.RawMessage, error) {
	var out struct {
		Routes []json.RawMessage `json:"routes"`
	}
	err := c.do(ctx, http.MethodGet, "/admin/v1/routes", nil, nil, &out)
	return out.Routes, err
}

// ReloadRoutes asks the gateway to reload its routes file and returns the number of routes.
func (c *Client) ReloadRoutes(ctx context.Context) (int, error) {
	var out struct {
		Routes int `json:"routes"`
	}
	err := c.do(ctx, http.MethodPost, "/admin/v1/routes/reload", nil, nil, &out)
	return out.Routes, err
}

// do sends one request to path, which is escaped already. in, when not nil, is sent as JSON; a
// 2xx response is decoded into out when out is not nil, and any other response becomes an
// *APIError.
func (c *Client) do(ctx context.Context, method, path string, query url.Values, in, out any) error {
	u := *c.base
	escaped := strings.TrimSuffix(c.base.EscapedPath(), "/") + path
	unescaped, err := url.PathUnescape(escaped)
	if err != nil {
		return fmt.Errorf("build request path: %w", err)
	}
	u.Path, u.RawPath = unescaped, escaped
	u.RawQuery = query.Encode()

	var body io.Reader
	if in != nil {
		data, err := json.Marshal(in)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var eb struct {
			Error APIError `json:"error"`
		}
		if err := json.Unmarshal(data, &eb); err != nil || eb.Error.Code == "" {
			return &APIError{Status: resp.StatusCode, Code: "http_error", Message: strings.TrimSpace(string(data))}
		}
		eb.Error.Status = resp.StatusCode
		return &eb.Error
	}
	if out == nil || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}
