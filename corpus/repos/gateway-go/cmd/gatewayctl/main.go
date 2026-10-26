// Command gatewayctl manages consumers and credentials through the gateway's admin API, and
// signs requests for routes that require HMAC authentication.
//
//	gatewayctl consumers
//	gatewayctl consumer-create -disabled billing-service
//	gatewayctl consumer-update -name billing -enable c_3f9a0c2b7d14e6a8
//	gatewayctl key-issue c_3f9a0c2b7d14e6a8
//	gatewayctl key-revoke c_3f9a0c2b7d14e6a8 0a1b2c3d4e5f
//	gatewayctl hmac-create c_3f9a0c2b7d14e6a8
//	gatewayctl routes
//	gatewayctl reload
//	gatewayctl sign -key-id hk_… -secret … -method POST -path /orders -body-file order.json
//
// The admin API and token come from GATEWAY_ADMIN_URL (default http://127.0.0.1:9090) and
// GATEWAY_ADMIN_TOKEN; sign needs neither.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"

	"github.com/relaywork/gateway/internal/client"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
}

// errUsage reports a command line that could not be parsed; the usage text has been printed.
var errUsage = errors.New("usage")

const usage = `usage: gatewayctl <command> [flags] [args]

commands:
  consumers          [-offset N] [-limit N]
  consumer           ID
  consumer-create    [-disabled] NAME
  consumer-update    [-name NAME] [-enable | -disable] ID
  consumer-delete    ID
  keys               CONSUMER_ID
  key-issue          CONSUMER_ID
  key-revoke         CONSUMER_ID PREFIX
  hmac-secrets       CONSUMER_ID
  hmac-create        CONSUMER_ID
  hmac-revoke        CONSUMER_ID KEY_ID
  routes
  reload
  sign               -key-id ID -secret S -method M -path P [-query Q] [-body-file F] [-timestamp T]
                     signs M upper-cased and P and Q exactly as the request will send them

environment:
  GATEWAY_ADMIN_URL    admin API base URL (default http://127.0.0.1:9090)
  GATEWAY_ADMIN_TOKEN  admin token (required except for sign)
`

// command runs one subcommand. Offline commands do not call the API and get a nil client.
type command struct {
	offline bool
	run     func(ctx context.Context, c *client.Client, args []string, e env) error
}

// env is where a command writes.
type env struct {
	stdout, stderr io.Writer
}

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
		fmt.Fprintf(stderr, "gatewayctl: unknown command %q\n\n%s", args[0], usage)
		return 2
	}
	var c *client.Client
	if !cmd.offline {
		var err error
		c, err = newAPIClient(getenv)
		if err != nil {
			fmt.Fprintln(stderr, "gatewayctl:", err)
			return 2
		}
	}
	err := cmd.run(ctx, c, args[1:], env{stdout: stdout, stderr: stderr})
	switch {
	case err == nil:
		return 0
	case errors.Is(err, errUsage):
		return 2
	default:
		fmt.Fprintln(stderr, "gatewayctl:", err)
		return 1
	}
}

func newAPIClient(getenv func(string) string) (*client.Client, error) {
	base := getenv("GATEWAY_ADMIN_URL")
	if base == "" {
		base = "http://127.0.0.1:9090"
	}
	token := getenv("GATEWAY_ADMIN_TOKEN")
	if token == "" {
		return nil, errors.New("GATEWAY_ADMIN_TOKEN is required")
	}
	return client.New(base, token, nil)
}
