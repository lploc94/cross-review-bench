package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/relaywork/gateway/internal/auth"
	"github.com/relaywork/gateway/internal/client"
)

var commands = map[string]command{
	"consumers":       {run: listConsumers},
	"consumer":        {run: getConsumer},
	"consumer-create": {run: createConsumer},
	"consumer-update": {run: updateConsumer},
	"consumer-delete": {run: deleteConsumer},
	"keys":            {run: listKeys},
	"key-issue":       {run: issueKey},
	"key-revoke":      {run: revokeKey},
	"hmac-secrets":    {run: listHMACSecrets},
	"hmac-create":     {run: createHMACSecret},
	"hmac-revoke":     {run: revokeHMACSecret},
	"routes":          {run: listRoutes},
	"reload":          {run: reloadRoutes},
	"sign":            {run: signRequest, offline: true},
}

// parse parses flags and checks the number of positional arguments.
func parse(fs *flag.FlagSet, args []string, wantArgs int, e env) ([]string, error) {
	fs.SetOutput(e.stderr)
	if err := fs.Parse(args); err != nil {
		return nil, errUsage
	}
	if fs.NArg() != wantArgs {
		fmt.Fprintf(e.stderr, "%s takes %d argument(s), got %d\n\n%s", fs.Name(), wantArgs, fs.NArg(), usage)
		return nil, errUsage
	}
	return fs.Args(), nil
}

func printJSON(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func listConsumers(ctx context.Context, c *client.Client, args []string, e env) error {
	fs := flag.NewFlagSet("consumers", flag.ContinueOnError)
	offset := fs.Int("offset", 0, "skip this many consumers")
	limit := fs.Int("limit", 100, "list at most this many consumers")
	if _, err := parse(fs, args, 0, e); err != nil {
		return err
	}
	page, err := c.ListConsumers(ctx, *offset, *limit)
	if err != nil {
		return err
	}
	tw := tabwriter.NewWriter(e.stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tNAME\tENABLED\tCREATED")
	for _, cons := range page.Consumers {
		fmt.Fprintf(tw, "%s\t%s\t%t\t%s\n", cons.ID, cons.Name, cons.Enabled, cons.CreatedAt.Format(time.RFC3339))
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	if shown := page.Offset + len(page.Consumers); shown < page.Total {
		fmt.Fprintf(e.stderr, "%d of %d consumers shown; next page: -offset %d\n", shown, page.Total, shown)
	}
	return nil
}

func getConsumer(ctx context.Context, c *client.Client, args []string, e env) error {
	pos, err := parse(flag.NewFlagSet("consumer", flag.ContinueOnError), args, 1, e)
	if err != nil {
		return err
	}
	cons, err := c.GetConsumer(ctx, pos[0])
	if err != nil {
		return err
	}
	return printJSON(e.stdout, cons)
}

func createConsumer(ctx context.Context, c *client.Client, args []string, e env) error {
	fs := flag.NewFlagSet("consumer-create", flag.ContinueOnError)
	disabled := fs.Bool("disabled", false, "create the consumer disabled")
	pos, err := parse(fs, args, 1, e)
	if err != nil {
		return err
	}
	cons, err := c.CreateConsumer(ctx, pos[0], !*disabled)
	if err != nil {
		return err
	}
	return printJSON(e.stdout, cons)
}

func updateConsumer(ctx context.Context, c *client.Client, args []string, e env) error {
	fs := flag.NewFlagSet("consumer-update", flag.ContinueOnError)
	name := fs.String("name", "", "rename the consumer")
	enable := fs.Bool("enable", false, "enable the consumer")
	disable := fs.Bool("disable", false, "disable the consumer")
	pos, err := parse(fs, args, 1, e)
	if err != nil {
		return err
	}
	if *enable && *disable {
		fmt.Fprintln(e.stderr, "consumer-update: -enable and -disable are mutually exclusive")
		return errUsage
	}
	var namePtr *string
	var enabledPtr *bool
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "name" {
			namePtr = name
		}
	})
	if *enable || *disable {
		v := *enable
		enabledPtr = &v
	}
	if namePtr == nil && enabledPtr == nil {
		fmt.Fprintln(e.stderr, "consumer-update: nothing to change; give -name, -enable or -disable")
		return errUsage
	}
	cons, err := c.UpdateConsumer(ctx, pos[0], namePtr, enabledPtr)
	if err != nil {
		return err
	}
	return printJSON(e.stdout, cons)
}

func deleteConsumer(ctx context.Context, c *client.Client, args []string, e env) error {
	pos, err := parse(flag.NewFlagSet("consumer-delete", flag.ContinueOnError), args, 1, e)
	if err != nil {
		return err
	}
	if err := c.DeleteConsumer(ctx, pos[0]); err != nil {
		return err
	}
	fmt.Fprintf(e.stdout, "deleted %s\n", pos[0])
	return nil
}

func listKeys(ctx context.Context, c *client.Client, args []string, e env) error {
	pos, err := parse(flag.NewFlagSet("keys", flag.ContinueOnError), args, 1, e)
	if err != nil {
		return err
	}
	keys, err := c.ListKeys(ctx, pos[0])
	if err != nil {
		return err
	}
	tw := tabwriter.NewWriter(e.stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "PREFIX\tCREATED\tLAST USED\tREVOKED")
	for _, k := range keys {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", k.Prefix, k.CreatedAt.Format(time.RFC3339), formatOptional(k.LastUsedAt), formatOptional(k.RevokedAt))
	}
	return tw.Flush()
}

func formatOptional(t *time.Time) string {
	if t == nil {
		return "-"
	}
	return t.Format(time.RFC3339)
}

func issueKey(ctx context.Context, c *client.Client, args []string, e env) error {
	pos, err := parse(flag.NewFlagSet("key-issue", flag.ContinueOnError), args, 1, e)
	if err != nil {
		return err
	}
	issued, err := c.IssueKey(ctx, pos[0])
	if err != nil {
		return err
	}
	fmt.Fprintf(e.stdout, "%s\n", issued.Key)
	fmt.Fprintf(e.stderr, "API key %s issued for %s. It is shown only now; store it safely.\n", issued.APIKey.Prefix, issued.APIKey.ConsumerID)
	return nil
}

func revokeKey(ctx context.Context, c *client.Client, args []string, e env) error {
	pos, err := parse(flag.NewFlagSet("key-revoke", flag.ContinueOnError), args, 2, e)
	if err != nil {
		return err
	}
	if err := c.RevokeKey(ctx, pos[0], pos[1]); err != nil {
		return err
	}
	fmt.Fprintf(e.stdout, "revoked %s\n", pos[1])
	return nil
}

func listHMACSecrets(ctx context.Context, c *client.Client, args []string, e env) error {
	pos, err := parse(flag.NewFlagSet("hmac-secrets", flag.ContinueOnError), args, 1, e)
	if err != nil {
		return err
	}
	creds, err := c.ListHMACSecrets(ctx, pos[0])
	if err != nil {
		return err
	}
	tw := tabwriter.NewWriter(e.stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "KEY ID\tCREATED\tREVOKED")
	for _, cr := range creds {
		fmt.Fprintf(tw, "%s\t%s\t%s\n", cr.KeyID, cr.CreatedAt.Format(time.RFC3339), formatOptional(cr.RevokedAt))
	}
	return tw.Flush()
}

func createHMACSecret(ctx context.Context, c *client.Client, args []string, e env) error {
	pos, err := parse(flag.NewFlagSet("hmac-create", flag.ContinueOnError), args, 1, e)
	if err != nil {
		return err
	}
	created, err := c.CreateHMACSecret(ctx, pos[0])
	if err != nil {
		return err
	}
	fmt.Fprintf(e.stdout, "key_id=%s\nsecret=%s\n", created.KeyID, created.Secret)
	fmt.Fprintln(e.stderr, "The secret is shown only now; store it safely.")
	return nil
}

func revokeHMACSecret(ctx context.Context, c *client.Client, args []string, e env) error {
	pos, err := parse(flag.NewFlagSet("hmac-revoke", flag.ContinueOnError), args, 2, e)
	if err != nil {
		return err
	}
	if err := c.RevokeHMACSecret(ctx, pos[0], pos[1]); err != nil {
		return err
	}
	fmt.Fprintf(e.stdout, "revoked %s\n", pos[1])
	return nil
}

func listRoutes(ctx context.Context, c *client.Client, args []string, e env) error {
	if _, err := parse(flag.NewFlagSet("routes", flag.ContinueOnError), args, 0, e); err != nil {
		return err
	}
	routes, err := c.Routes(ctx)
	if err != nil {
		return err
	}
	return printJSON(e.stdout, routes)
}

func reloadRoutes(ctx context.Context, c *client.Client, args []string, e env) error {
	if _, err := parse(flag.NewFlagSet("reload", flag.ContinueOnError), args, 0, e); err != nil {
		return err
	}
	n, err := c.ReloadRoutes(ctx)
	if err != nil {
		return err
	}
	fmt.Fprintf(e.stdout, "reloaded %d routes\n", n)
	return nil
}

// signRequest prints the Authorization header for a request to an HMAC route.
func signRequest(_ context.Context, _ *client.Client, args []string, e env) error {
	fs := flag.NewFlagSet("sign", flag.ContinueOnError)
	keyID := fs.String("key-id", "", "HMAC key id (required)")
	secret := fs.String("secret", "", "HMAC secret (required)")
	method := fs.String("method", "GET", "request method; upper-cased, as HTTP clients send it")
	path := fs.String("path", "", "request path as it will be sent, escaped (required)")
	query := fs.String("query", "", "raw query string, without '?'")
	bodyFile := fs.String("body-file", "", "file holding the request body")
	timestamp := fs.Int64("timestamp", 0, "Unix seconds to sign with (default now)")
	if _, err := parse(fs, args, 0, e); err != nil {
		return err
	}
	if *keyID == "" || *secret == "" || *path == "" {
		fmt.Fprintln(e.stderr, "sign: -key-id, -secret and -path are required")
		return errUsage
	}
	if _, err := url.ParseRequestURI(*path); err != nil || !strings.HasPrefix(*path, "/") || strings.ContainsAny(*path, "?#") {
		return fmt.Errorf("sign: -path must be an absolute path without query or fragment (use -query), got %q", *path)
	}
	var body []byte
	if *bodyFile != "" {
		var err error
		if body, err = os.ReadFile(*bodyFile); err != nil {
			return err
		}
	}
	ts := *timestamp
	if ts == 0 {
		ts = time.Now().Unix()
	}
	// The gateway checks the method exactly as sent, and clients send standard methods in upper
	// case; "-method post" means POST.
	sig, err := auth.Sign(*secret, strings.ToUpper(*method), *path, *query, ts, body)
	if err != nil {
		return err
	}
	fmt.Fprintf(e.stdout, "Authorization: %s\n", auth.AuthorizationHeader(*keyID, sig, ts))
	return nil
}
