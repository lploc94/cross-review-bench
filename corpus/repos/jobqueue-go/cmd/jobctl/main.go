// Command jobctl manages jobs through the jobqueue HTTP API.
//
//	jobctl enqueue -queue default -type http.post -payload '{"url":"https://example.com/hook"}'
//	jobctl get 42
//	jobctl list -queue default -state available
//	jobctl cancel 42
//	jobctl dead -queue default
//	jobctl requeue 42 43
//	jobctl wait -timeout 5m 42
//	jobctl schedule-put -spec '*/5 * * * *' -type noop heartbeat
//
// The server and token come from JOBQUEUE_URL (default http://localhost:8080) and
// JOBQUEUE_TOKEN.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
}

// errUsage reports a command line that could not be parsed; the usage text has been printed.
var errUsage = errors.New("usage")

const usage = `usage: jobctl <command> [flags] [args]

commands:
  enqueue  -queue Q -type T [-payload JSON] [-priority N] [-max-attempts N] [-delay D]
  get      ID
  list     [-queue Q] [-state S] [-after ID] [-limit N]
  cancel   ID
  dead     [-queue Q] [-after ID] [-limit N]
  requeue  ID...
  wait     [-timeout D] [-interval D] ID
  schedules
  schedule         NAME
  schedule-put     -spec S -type T [-queue Q] [-payload JSON] [-disabled] NAME
  schedule-delete  NAME

environment:
  JOBQUEUE_URL    server base URL (default http://localhost:8080)
  JOBQUEUE_TOKEN  admin token (required)
`

// run executes one command and returns the process exit code: 0 on success, 1 when the
// command failed, 2 on a usage error.
func run(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "help" || args[0] == "--help" {
		fmt.Fprint(stderr, usage)
		if len(args) == 0 {
			return 2
		}
		return 0
	}
	cmd, ok := commands[args[0]]
	if !ok {
		fmt.Fprintf(stderr, "jobctl: unknown command %q\n\n%s", args[0], usage)
		return 2
	}
	c, err := newAPIClient(getenv)
	if err != nil {
		fmt.Fprintln(stderr, "jobctl:", err)
		return 2
	}
	err = cmd(ctx, c, args[1:], stdout, stderr)
	switch {
	case err == nil:
		return 0
	case errors.Is(err, errUsage):
		return 2
	default:
		fmt.Fprintf(stderr, "jobctl %s: %v\n", args[0], err)
		return 1
	}
}
