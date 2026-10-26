package proxy

import "github.com/relaywork/gateway/internal/metrics"

// upstreamBuckets suit upstream response times, from fast cache hits to slow reports.
var upstreamBuckets = []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60}

type proxyMetrics struct {
	requests        *metrics.Counter
	upstreamLatency *metrics.Histogram
	retries         *metrics.Counter
	rateLimited     *metrics.Counter
	rateLimitErrors *metrics.Counter
	authFailures    *metrics.Counter
}

func newProxyMetrics(reg *metrics.Registry) proxyMetrics {
	return proxyMetrics{
		requests: reg.NewCounter("gateway_requests_total",
			"Proxied requests by route and status class; route is \"unmatched\" when no route matched.", "route", "class"),
		upstreamLatency: reg.NewHistogram("gateway_upstream_duration_seconds",
			"Time from sending a request to an upstream until its response headers arrived, per attempt.", upstreamBuckets, "route"),
		retries: reg.NewCounter("gateway_retries_total",
			"Attempts after the first, by route.", "route"),
		rateLimited: reg.NewCounter("gateway_rate_limit_rejections_total",
			"Requests rejected with 429 by the rate limiter, by route.", "route"),
		rateLimitErrors: reg.NewCounter("gateway_rate_limit_errors_total",
			"Requests let through because the rate limiter failed, by route.", "route"),
		authFailures: reg.NewCounter("gateway_auth_failures_total",
			"Requests rejected with 401, by route and error code.", "route", "code"),
	}
}
