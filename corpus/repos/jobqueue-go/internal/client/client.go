// Package client is a Go client for the jobqueue HTTP API, used by jobctl.
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
)

// Job mirrors the API's job representation.
type Job struct {
	ID          int64           `json:"id"`
	Queue       string          `json:"queue"`
	Type        string          `json:"type"`
	Payload     json.RawMessage `json:"payload"`
	Priority    int             `json:"priority"`
	State       string          `json:"state"`
	Attempts    int             `json:"attempts"`
	MaxAttempts int             `json:"max_attempts"`
	RunAt       time.Time       `json:"run_at"`
	LockedBy    *string         `json:"locked_by"`
	LockedUntil *time.Time      `json:"locked_until"`
	LastError   *string         `json:"last_error"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
	FinishedAt  *time.Time      `json:"finished_at"`
}

// JobPage is one page of a job listing.
type JobPage struct {
	Jobs      []Job  `json:"jobs"`
	NextAfter *int64 `json:"next_after"`
}

// EnqueueRequest is the body of an enqueue call. Zero fields take the server's defaults.
type EnqueueRequest struct {
	Type        string          `json:"type"`
	Payload     json.RawMessage `json:"payload,omitempty"`
	Priority    int             `json:"priority,omitempty"`
	MaxAttempts int             `json:"max_attempts,omitempty"`
	RunAt       *time.Time      `json:"run_at,omitempty"`
}

// ListOptions filters a job listing. Zero fields do not filter.
type ListOptions struct {
	Queue string
	State string
	After int64
	Limit int
}

// FieldError is one invalid field reported by the server.
type FieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// APIError is an error response from the server.
type APIError struct {
	Status    int
	Code      string       `json:"code"`
	Message   string       `json:"message"`
	Fields    []FieldError `json:"fields"`
	RequestID string       `json:"request_id"`
}

func (e *APIError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%d %s: %s", e.Status, e.Code, e.Message)
	for _, f := range e.Fields {
		fmt.Fprintf(&b, "; %s: %s", f.Field, f.Message)
	}
	return b.String()
}

// IsNotFound reports whether err is a 404 from the server.
func IsNotFound(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound
}

// Client calls the API with the admin token.
type Client struct {
	base  *url.URL
	token string
	http  *http.Client
}

// New returns a client for the server at baseURL (for example http://localhost:8080). A nil
// httpClient means one with a 30 second timeout.
func New(baseURL, token string, httpClient *http.Client) (*Client, error) {
	u, err := url.Parse(baseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("client: base URL must be an absolute http or https URL, got %q", baseURL)
	}
	if token == "" {
		return nil, errors.New("client: token is required")
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{base: u, token: token, http: httpClient}, nil
}

// Enqueue adds a job to queue.
func (c *Client) Enqueue(ctx context.Context, queue string, req EnqueueRequest) (Job, error) {
	var job Job
	err := c.do(ctx, http.MethodPost, "/v1/queues/"+url.PathEscape(queue)+"/jobs", nil, req, &job)
	return job, err
}

// GetJob returns one job.
func (c *Client) GetJob(ctx context.Context, id int64) (Job, error) {
	var job Job
	err := c.do(ctx, http.MethodGet, "/v1/jobs/"+strconv.FormatInt(id, 10), nil, nil, &job)
	return job, err
}

// ListJobs returns one page of jobs.
func (c *Client) ListJobs(ctx context.Context, opts ListOptions) (JobPage, error) {
	var page JobPage
	err := c.do(ctx, http.MethodGet, "/v1/jobs", opts.query(), nil, &page)
	return page, err
}

// CancelJob cancels an available job.
func (c *Client) CancelJob(ctx context.Context, id int64) (Job, error) {
	var job Job
	err := c.do(ctx, http.MethodPost, "/v1/jobs/"+strconv.FormatInt(id, 10)+"/cancel", nil, nil, &job)
	return job, err
}

// ListDead returns one page of dead jobs; opts.State is ignored.
func (c *Client) ListDead(ctx context.Context, opts ListOptions) (JobPage, error) {
	opts.State = ""
	var page JobPage
	err := c.do(ctx, http.MethodGet, "/v1/dead", opts.query(), nil, &page)
	return page, err
}

// Requeue makes a dead job available again.
func (c *Client) Requeue(ctx context.Context, id int64) (Job, error) {
	var job Job
	err := c.do(ctx, http.MethodPost, "/v1/dead/"+strconv.FormatInt(id, 10)+"/requeue", nil, nil, &job)
	return job, err
}

func (o ListOptions) query() url.Values {
	q := url.Values{}
	if o.Queue != "" {
		q.Set("queue", o.Queue)
	}
	if o.State != "" {
		q.Set("state", o.State)
	}
	if o.After > 0 {
		q.Set("after", strconv.FormatInt(o.After, 10))
	}
	if o.Limit > 0 {
		q.Set("limit", strconv.Itoa(o.Limit))
	}
	return q
}

// do sends a request with an optional JSON body and decodes a JSON response into out.
func (c *Client) do(ctx context.Context, method, path string, query url.Values, in, out any) error {
	u := c.base.JoinPath(path)
	u.RawQuery = query.Encode()

	var body io.Reader
	if in != nil {
		buf, err := json.Marshal(in)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		body = bytes.NewReader(buf)
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
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode >= 300 {
		return decodeError(resp.StatusCode, data)
	}
	if out == nil || len(data) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

func decodeError(status int, data []byte) error {
	var body struct {
		Error *APIError `json:"error"`
	}
	if err := json.Unmarshal(data, &body); err != nil || body.Error == nil {
		return &APIError{Status: status, Code: "unexpected_response", Message: strings.TrimSpace(string(data))}
	}
	body.Error.Status = status
	return body.Error
}

// Schedule mirrors the API's schedule representation.
type Schedule struct {
	Name      string          `json:"name"`
	Spec      string          `json:"spec"`
	Queue     string          `json:"queue"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	Enabled   bool            `json:"enabled"`
	NextRunAt time.Time       `json:"next_run_at"`
	LastRunAt *time.Time      `json:"last_run_at"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`
}

// ScheduleRequest creates or replaces a schedule. A nil Enabled means enabled.
type ScheduleRequest struct {
	Spec    string          `json:"spec"`
	Queue   string          `json:"queue"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Enabled *bool           `json:"enabled,omitempty"`
}

// ListSchedules returns every schedule.
func (c *Client) ListSchedules(ctx context.Context) ([]Schedule, error) {
	var out struct {
		Schedules []Schedule `json:"schedules"`
	}
	err := c.do(ctx, http.MethodGet, "/v1/schedules", nil, nil, &out)
	return out.Schedules, err
}

// GetSchedule returns one schedule.
func (c *Client) GetSchedule(ctx context.Context, name string) (Schedule, error) {
	var sc Schedule
	err := c.do(ctx, http.MethodGet, "/v1/schedules/"+url.PathEscape(name), nil, nil, &sc)
	return sc, err
}

// PutSchedule creates or replaces the schedule called name.
func (c *Client) PutSchedule(ctx context.Context, name string, req ScheduleRequest) (Schedule, error) {
	var sc Schedule
	err := c.do(ctx, http.MethodPut, "/v1/schedules/"+url.PathEscape(name), nil, req, &sc)
	return sc, err
}

// DeleteSchedule removes the schedule called name.
func (c *Client) DeleteSchedule(ctx context.Context, name string) error {
	return c.do(ctx, http.MethodDelete, "/v1/schedules/"+url.PathEscape(name), nil, nil, nil)
}
