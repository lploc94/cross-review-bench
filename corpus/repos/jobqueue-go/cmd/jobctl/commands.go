package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/relaywork/jobqueue/internal/client"
)

const defaultURL = "http://localhost:8080"

type command func(ctx context.Context, c *client.Client, args []string, stdout, stderr io.Writer) error

var commands = map[string]command{
	"enqueue": enqueueCmd,
	"get":     getCmd,
	"list":    listCmd,
	"cancel":  cancelCmd,
	"dead":    deadCmd,
	"requeue": requeueCmd,
	"wait":    waitCmd,

	"schedules":       schedulesCmd,
	"schedule":        scheduleCmd,
	"schedule-put":    schedulePutCmd,
	"schedule-delete": scheduleDeleteCmd,
}

func newAPIClient(getenv func(string) string) (*client.Client, error) {
	base := getenv("JOBQUEUE_URL")
	if base == "" {
		base = defaultURL
	}
	token := getenv("JOBQUEUE_TOKEN")
	if token == "" {
		return nil, errors.New("JOBQUEUE_TOKEN is not set")
	}
	return client.New(base, token, nil)
}

// newFlags returns a flag set that reports errors to stderr instead of exiting.
func newFlags(name string, stderr io.Writer) *flag.FlagSet {
	fs := flag.NewFlagSet("jobctl "+name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	return fs
}

func parse(fs *flag.FlagSet, args []string) error {
	if err := fs.Parse(args); err != nil {
		return errUsage
	}
	return nil
}

func enqueueCmd(ctx context.Context, c *client.Client, args []string, stdout, stderr io.Writer) error {
	fs := newFlags("enqueue", stderr)
	queue := fs.String("queue", "default", "queue name")
	typ := fs.String("type", "", "job type (required)")
	payload := fs.String("payload", "", "JSON object passed to the handler")
	priority := fs.Int("priority", 0, "higher runs first")
	maxAttempts := fs.Int("max-attempts", 0, "attempts before the job is dead (0: server default)")
	delay := fs.Duration("delay", 0, "run no earlier than this long from now")
	if err := parse(fs, args); err != nil {
		return err
	}
	if *typ == "" || fs.NArg() > 0 {
		fmt.Fprintln(stderr, "jobctl enqueue: -type is required and no arguments are accepted")
		fs.Usage()
		return errUsage
	}
	req := client.EnqueueRequest{Type: *typ, Priority: *priority, MaxAttempts: *maxAttempts}
	if *payload != "" {
		if !json.Valid([]byte(*payload)) {
			return errors.New("-payload is not valid JSON")
		}
		req.Payload = json.RawMessage(*payload)
	}
	if *delay > 0 {
		at := time.Now().Add(*delay).UTC()
		req.RunAt = &at
	}
	job, err := c.Enqueue(ctx, *queue, req)
	if err != nil {
		return err
	}
	return printJSON(stdout, job)
}

func getCmd(ctx context.Context, c *client.Client, args []string, stdout, stderr io.Writer) error {
	ids, err := parseIDs("get", args, stderr, 1)
	if err != nil {
		return err
	}
	job, err := c.GetJob(ctx, ids[0])
	if err != nil {
		return err
	}
	return printJSON(stdout, job)
}

func cancelCmd(ctx context.Context, c *client.Client, args []string, stdout, stderr io.Writer) error {
	ids, err := parseIDs("cancel", args, stderr, 1)
	if err != nil {
		return err
	}
	job, err := c.CancelJob(ctx, ids[0])
	if err != nil {
		return err
	}
	return printJSON(stdout, job)
}

// errNotSucceeded reports a waited-for job that reached a terminal state other than succeeded.
var errNotSucceeded = errors.New("job did not succeed")

// waitCmd polls a job until it reaches a terminal state, so that scripts can enqueue a job and
// wait for its result. It succeeds only if the job succeeded.
func waitCmd(ctx context.Context, c *client.Client, args []string, stdout, stderr io.Writer) error {
	fs := newFlags("wait", stderr)
	timeout := fs.Duration("timeout", 10*time.Minute, "give up after this long")
	interval := fs.Duration("interval", 2*time.Second, "time between polls")
	if err := parse(fs, args); err != nil {
		return err
	}
	ids, err := parseIDs("wait", fs.Args(), stderr, 1)
	if err != nil {
		return err
	}
	if *interval <= 0 {
		fmt.Fprintln(stderr, "jobctl wait: -interval must be positive")
		return errUsage
	}
	ctx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()
	ticker := time.NewTicker(*interval)
	defer ticker.Stop()
	for {
		job, err := c.GetJob(ctx, ids[0])
		if err != nil {
			return err
		}
		if terminalStates[job.State] {
			if err := printJSON(stdout, job); err != nil {
				return err
			}
			if job.State != "succeeded" {
				return fmt.Errorf("job %d is %s: %w", job.ID, job.State, errNotSucceeded)
			}
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("job %d is still %s: %w", job.ID, job.State, ctx.Err())
		case <-ticker.C:
		}
	}
}

var terminalStates = map[string]bool{"succeeded": true, "failed": true, "cancelled": true, "dead": true}

// requeueCmd requeues each dead job given and reports every failure, not only the first.
func requeueCmd(ctx context.Context, c *client.Client, args []string, stdout, stderr io.Writer) error {
	ids, err := parseIDs("requeue", args, stderr, 0)
	if err != nil {
		return err
	}
	var errs []error
	for _, id := range ids {
		job, err := c.Requeue(ctx, id)
		if err != nil {
			errs = append(errs, fmt.Errorf("job %d: %w", id, err))
			continue
		}
		fmt.Fprintf(stdout, "requeued job %d (%s/%s)\n", job.ID, job.Queue, job.Type)
	}
	return errors.Join(errs...)
}

func listCmd(ctx context.Context, c *client.Client, args []string, stdout, stderr io.Writer) error {
	fs := newFlags("list", stderr)
	opts := listFlags(fs)
	state := fs.String("state", "", "filter by state")
	if err := parse(fs, args); err != nil {
		return err
	}
	opts.State = *state
	page, err := c.ListJobs(ctx, *opts)
	if err != nil {
		return err
	}
	return printPage(stdout, page)
}

func deadCmd(ctx context.Context, c *client.Client, args []string, stdout, stderr io.Writer) error {
	fs := newFlags("dead", stderr)
	opts := listFlags(fs)
	if err := parse(fs, args); err != nil {
		return err
	}
	page, err := c.ListDead(ctx, *opts)
	if err != nil {
		return err
	}
	return printPage(stdout, page)
}

func schedulesCmd(ctx context.Context, c *client.Client, args []string, stdout, stderr io.Writer) error {
	if len(args) > 0 {
		fmt.Fprintln(stderr, "jobctl schedules: no arguments are accepted")
		return errUsage
	}
	list, err := c.ListSchedules(ctx)
	if err != nil {
		return err
	}
	tw := tabwriter.NewWriter(stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "NAME\tSPEC\tQUEUE\tTYPE\tENABLED\tNEXT RUN\tLAST RUN")
	for _, sc := range list {
		last := "-"
		if sc.LastRunAt != nil {
			last = sc.LastRunAt.Format(time.RFC3339)
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%t\t%s\t%s\n", sc.Name, sc.Spec, sc.Queue, sc.Type, sc.Enabled,
			sc.NextRunAt.Format(time.RFC3339), last)
	}
	return tw.Flush()
}

func scheduleCmd(ctx context.Context, c *client.Client, args []string, stdout, stderr io.Writer) error {
	if len(args) != 1 {
		fmt.Fprintln(stderr, "jobctl schedule: expected one schedule name")
		return errUsage
	}
	sc, err := c.GetSchedule(ctx, args[0])
	if err != nil {
		return err
	}
	return printJSON(stdout, sc)
}

func schedulePutCmd(ctx context.Context, c *client.Client, args []string, stdout, stderr io.Writer) error {
	fs := newFlags("schedule-put", stderr)
	spec := fs.String("spec", "", "cron expression, evaluated in UTC (required)")
	queue := fs.String("queue", "default", "queue of the enqueued jobs")
	typ := fs.String("type", "", "type of the enqueued jobs (required)")
	payload := fs.String("payload", "", "JSON object passed to each job")
	disabled := fs.Bool("disabled", false, "save the schedule without enabling it")
	if err := parse(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 || *spec == "" || *typ == "" {
		fmt.Fprintln(stderr, "jobctl schedule-put: usage: schedule-put -spec S -type T [flags] NAME")
		fs.Usage()
		return errUsage
	}
	enabled := !*disabled
	req := client.ScheduleRequest{Spec: *spec, Queue: *queue, Type: *typ, Enabled: &enabled}
	if *payload != "" {
		if !json.Valid([]byte(*payload)) {
			return errors.New("-payload is not valid JSON")
		}
		req.Payload = json.RawMessage(*payload)
	}
	sc, err := c.PutSchedule(ctx, fs.Arg(0), req)
	if err != nil {
		return err
	}
	return printJSON(stdout, sc)
}

func scheduleDeleteCmd(ctx context.Context, c *client.Client, args []string, stdout, stderr io.Writer) error {
	if len(args) != 1 {
		fmt.Fprintln(stderr, "jobctl schedule-delete: expected one schedule name")
		return errUsage
	}
	if err := c.DeleteSchedule(ctx, args[0]); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "deleted schedule %s\n", args[0])
	return nil
}

func listFlags(fs *flag.FlagSet) *client.ListOptions {
	opts := &client.ListOptions{}
	fs.StringVar(&opts.Queue, "queue", "", "filter by queue")
	fs.Int64Var(&opts.After, "after", 0, "list jobs with an id greater than this")
	fs.IntVar(&opts.Limit, "limit", 0, "page size (0: server default)")
	return opts
}

// parseIDs parses positional job ids; want is the exact number expected, or 0 for one or more.
func parseIDs(name string, args []string, stderr io.Writer, want int) ([]int64, error) {
	if len(args) == 0 || (want > 0 && len(args) != want) {
		fmt.Fprintf(stderr, "jobctl %s: expected %s\n", name, plural(want))
		return nil, errUsage
	}
	ids := make([]int64, len(args))
	for i, a := range args {
		id, err := strconv.ParseInt(a, 10, 64)
		if err != nil || id <= 0 {
			fmt.Fprintf(stderr, "jobctl %s: %q is not a job id\n", name, a)
			return nil, errUsage
		}
		ids[i] = id
	}
	return ids, nil
}

func plural(want int) string {
	if want == 1 {
		return "one job id"
	}
	if want == 0 {
		return "one or more job ids"
	}
	return fmt.Sprintf("%d job ids", want)
}

func printJSON(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func printPage(w io.Writer, page client.JobPage) error {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tQUEUE\tTYPE\tSTATE\tATTEMPTS\tRUN AT\tLAST ERROR")
	for _, j := range page.Jobs {
		lastErr := ""
		if j.LastError != nil {
			lastErr = oneLine(*j.LastError, 60)
		}
		fmt.Fprintf(tw, "%d\t%s\t%s\t%s\t%d/%d\t%s\t%s\n", j.ID, j.Queue, j.Type, j.State,
			j.Attempts, j.MaxAttempts, j.RunAt.Format(time.RFC3339), lastErr)
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	if page.NextAfter != nil {
		fmt.Fprintf(w, "more: -after %d\n", *page.NextAfter)
	}
	return nil
}

// oneLine collapses whitespace and shortens s to at most n runes.
func oneLine(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
