package proxy

import (
	"fmt"
	"hash/fnv"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
)

// bucketOf is the canary bucket of a client key, as the canary computes it.
func bucketOf(key string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(key))
	return h.Sum32() % 100
}

// addrInBucket returns a client address whose canary bucket is bucket.
func addrInBucket(t *testing.T, bucket uint32) netip.Addr {
	t.Helper()
	for i := 0; i < 1<<16; i++ {
		a := netip.AddrFrom4([4]byte{10, 1, byte(i >> 8), byte(i)})
		if bucketOf(a.String()) == bucket {
			return a
		}
	}
	t.Fatalf("no client address in bucket %d", bucket)
	return netip.Addr{}
}

// A client whose bucket equals Percent is outside the canary's share: the share is the buckets
// below Percent, so percent 0 sends nobody to the canary and percent 50 leaves bucket 50 stable.
func TestCanaryBucketEqualToPercentStaysStable(t *testing.T) {
	for _, c := range []struct {
		percent int
		bucket  uint32
	}{{0, 0}, {50, 50}} {
		var host string
		tr := &fakeTransport{respond: func(_ int, r *http.Request) (*http.Response, error) {
			host = r.URL.Host
			return reply(r, http.StatusOK, "ok"), nil
		}}
		f := newFixture(t, fmt.Sprintf(canaryRoutes, c.percent), fixtureOptions{transport: tr})
		r := httptest.NewRequest(http.MethodGet, "/shop/cart", nil)
		r.RemoteAddr = addrInBucket(t, c.bucket).String() + ":4000"
		if w := f.do(r); w.Code != http.StatusOK {
			t.Fatalf("percent %d: status %d", c.percent, w.Code)
		}
		if host != "stable.internal" {
			t.Errorf("percent %d, bucket %d: reached %s, want stable.internal", c.percent, c.bucket, host)
		}
	}
}
