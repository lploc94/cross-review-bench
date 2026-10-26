package store

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/core"
)

func TestFixedWindowCountsAndRejects(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	lim := e.store.FixedWindow()
	p := core.RateLimitPolicy{Requests: 3, Window: time.Minute}
	// t0 is 12:00:00, the start of a minute window.
	e.clock.Advance(15 * time.Second)
	for i := 1; i <= 3; i++ {
		d, err := lim.Allow(ctx, "orders", "consumer:c1", p)
		if err != nil {
			t.Fatal(err)
		}
		if !d.Allowed || d.Remaining != 3-i || d.Limit != 3 || d.Reset != 45*time.Second {
			t.Fatalf("request %d: %+v", i, d)
		}
	}
	d, err := lim.Allow(ctx, "orders", "consumer:c1", p)
	if err != nil {
		t.Fatal(err)
	}
	if d.Allowed || d.Remaining != 0 || d.Reset != 45*time.Second {
		t.Errorf("fourth request: %+v, want rejected", d)
	}
}

func TestFixedWindowKeysAreIndependent(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	lim := e.store.FixedWindow()
	p := core.RateLimitPolicy{Requests: 1, Window: time.Minute}
	for _, k := range []struct{ route, consumer string }{{"a", "c1"}, {"a", "c2"}, {"b", "c1"}} {
		if d, _ := lim.Allow(ctx, k.route, k.consumer, p); !d.Allowed {
			t.Errorf("first request of %v rejected", k)
		}
	}
	if d, _ := lim.Allow(ctx, "a", "c1", p); d.Allowed {
		t.Error("second request of a/c1 allowed")
	}
}

func TestFixedWindowBoundaries(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	lim := e.store.FixedWindow()
	p := core.RateLimitPolicy{Requests: 1, Window: 10 * time.Second}

	e.clock.Set(t0.Add(10*time.Second - time.Millisecond)) // last millisecond of [0s, 10s)
	if d, _ := lim.Allow(ctx, "r", "c", p); !d.Allowed || d.Reset != time.Millisecond {
		t.Fatalf("last millisecond: %+v", d)
	}
	if d, _ := lim.Allow(ctx, "r", "c", p); d.Allowed {
		t.Fatal("second request in the same window allowed")
	}
	e.clock.Advance(time.Millisecond) // exactly 10s: a new window
	d, _ := lim.Allow(ctx, "r", "c", p)
	if !d.Allowed || d.Reset != 10*time.Second {
		t.Fatalf("first millisecond of the next window: %+v", d)
	}
	e.clock.Advance(9*time.Second + 999*time.Millisecond) // 19.999s: still the second window
	if d, _ := lim.Allow(ctx, "r", "c", p); d.Allowed {
		t.Error("window ended early")
	}
}

func TestFixedWindowCounterExpires(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	lim := e.store.FixedWindow()
	e.clock.Advance(4 * time.Second)
	if _, err := lim.Allow(ctx, "r", "c", core.RateLimitPolicy{Requests: 5, Window: 10 * time.Second}); err != nil {
		t.Fatal(err)
	}
	key := e.store.rateLimitKey("r", "c", t0.UnixMilli())
	ttl := e.rdb.PTTL(ctx, key).Val()
	// The window has 6s left; the counter lives that long plus the grace, never forever.
	if ttl <= 0 || ttl > 6*time.Second+counterGrace || ttl < 6*time.Second+counterGrace-2*time.Second {
		t.Errorf("PTTL = %s, want about %s", ttl, 6*time.Second+counterGrace)
	}
	// Later requests in the window do not extend it.
	e.clock.Advance(3 * time.Second)
	if _, err := lim.Allow(ctx, "r", "c", core.RateLimitPolicy{Requests: 5, Window: 10 * time.Second}); err != nil {
		t.Fatal(err)
	}
	if again := e.rdb.PTTL(ctx, key).Val(); again > ttl {
		t.Errorf("PTTL grew from %s to %s on a later hit", ttl, again)
	}
}

// TestFixedWindowIsAtomic sends many concurrent requests: exactly the limit gets through.
func TestFixedWindowIsAtomic(t *testing.T) {
	e := newEnv(t)
	lim := e.store.FixedWindow()
	const limit, racers = 25, 100
	p := core.RateLimitPolicy{Requests: limit, Window: time.Hour}
	start := make(chan struct{})
	var allowed atomic.Int32
	var wg sync.WaitGroup
	for range racers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			d, err := lim.Allow(context.Background(), "r", "c", p)
			if err != nil {
				t.Error(err)
				return
			}
			if d.Allowed {
				allowed.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()
	if got := allowed.Load(); got != limit {
		t.Errorf("%d requests allowed, want exactly %d", got, limit)
	}
}

func TestFixedWindowRejectsInvalidPolicy(t *testing.T) {
	s := New(nil, "test:", clock.NewManual(t0)) // rejected before Redis is called
	if _, err := s.FixedWindow().Allow(context.Background(), "r", "c", core.RateLimitPolicy{Requests: 1}); err == nil {
		t.Error("a zero window was accepted")
	}
}
