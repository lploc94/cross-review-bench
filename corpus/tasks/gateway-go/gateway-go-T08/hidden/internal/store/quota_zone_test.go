package store

import (
	"context"
	"testing"
	"time"
)

// A quota day is a calendar day of the quota zone, whatever the zone's offset is on that day.
func TestQuotaDayFollowsTheQuotaZone(t *testing.T) {
	saved := time.Local
	time.Local = time.UTC // the process zone must not decide the day
	defer func() { time.Local = saved }()
	ctx := context.Background()
	const id = "c_0123456789abcdef"

	// At 23:30 UTC it is already 3 June in Tokyo, so the quota used then stays used until Tokyo
	// midnight, even though it is 3 June in UTC at 00:30.
	t.Run("east of UTC", func(t *testing.T) {
		tokyo, err := time.LoadLocation("Asia/Tokyo")
		if err != nil {
			t.Fatal(err)
		}
		e := newEnv(t)
		e.store.SetQuotaZone(tokyo)

		e.clock.Set(time.Date(2025, time.June, 2, 23, 30, 0, 0, time.UTC))
		for i := 0; i < 2; i++ {
			if d, err := e.store.ConsumeQuota(ctx, id, 2); err != nil || !d.Allowed {
				t.Fatalf("request %d: %+v, %v", i+1, d, err)
			}
		}
		e.clock.Set(time.Date(2025, time.June, 3, 0, 30, 0, 0, time.UTC))
		d, err := e.store.ConsumeQuota(ctx, id, 2)
		if err != nil {
			t.Fatal(err)
		}
		if d.Allowed {
			t.Fatalf("quota of 3 June (Tokyo) was reset at 00:30 UTC: %+v", d)
		}
		want := time.Date(2025, time.June, 4, 0, 0, 0, 0, tokyo).Sub(e.clock.Now())
		if d.RetryAfter != want {
			t.Errorf("RetryAfter = %v, want %v", d.RetryAfter, want)
		}
	})

	// The gateway starts in December (EST, UTC-5) and serves requests in June (EDT, UTC-4): the
	// day still runs from midnight to midnight in New York, which is 04:00 UTC in summer.
	t.Run("a zone with daylight saving time", func(t *testing.T) {
		newYork, err := time.LoadLocation("America/New_York")
		if err != nil {
			t.Fatal(err)
		}
		e := newEnv(t)
		e.clock.Set(time.Date(2025, time.December, 15, 12, 0, 0, 0, time.UTC))
		e.store.SetQuotaZone(newYork)

		e.clock.Set(time.Date(2026, time.June, 3, 4, 30, 0, 0, time.UTC)) // 00:30 on 3 June in New York
		for i := 0; i < 2; i++ {
			if d, err := e.store.ConsumeQuota(ctx, id, 2); err != nil || !d.Allowed {
				t.Fatalf("request %d: %+v, %v", i+1, d, err)
			}
		}
		for _, at := range []time.Time{
			time.Date(2026, time.June, 3, 5, 30, 0, 0, time.UTC), // 01:30 on 3 June in New York
			time.Date(2026, time.June, 4, 0, 30, 0, 0, time.UTC), // 20:30 on 3 June in New York
		} {
			e.clock.Set(at)
			d, err := e.store.ConsumeQuota(ctx, id, 2)
			if err != nil {
				t.Fatal(err)
			}
			if d.Allowed {
				t.Fatalf("quota of 3 June (New York) used up at 00:30 EDT was fresh again at %s: %+v",
					at.In(newYork).Format("15:04 MST"), d)
			}
			want := time.Date(2026, time.June, 4, 0, 0, 0, 0, newYork).Sub(e.clock.Now())
			if d.RetryAfter != want {
				t.Errorf("RetryAfter at %s = %v, want %v", at.In(newYork).Format("15:04 MST"), d.RetryAfter, want)
			}
		}
	})
}
