// Package metrics implements counters, gauges and histograms with labels, exposed in the
// Prometheus text format (version 0.0.4).
package metrics

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
	"sync"
)

var (
	metricNamePattern = regexp.MustCompile(`^[a-zA-Z_:][a-zA-Z0-9_:]*$`)
	labelNamePattern  = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)
)

// DefaultBuckets are histogram buckets suited to request and job durations in seconds.
var DefaultBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300}

type metricType string

const (
	typeCounter   metricType = "counter"
	typeGauge     metricType = "gauge"
	typeHistogram metricType = "histogram"
)

// Registry holds metric families in registration order. It is safe for concurrent use.
type Registry struct {
	mu       sync.Mutex
	families []*family
	byName   map[string]*family
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{byName: make(map[string]*family)}
}

// family is one metric name with its label names and the series seen so far.
type family struct {
	name    string
	help    string
	typ     metricType
	labels  []string
	buckets []float64      // histograms only
	read    func() float64 // gauge funcs only

	mu     sync.Mutex
	series map[string]*series
}

// series is one combination of label values.
type series struct {
	labelValues []string
	value       float64  // counters and gauges
	counts      []uint64 // histograms: observations per bucket, not cumulative
	sum         float64  // histograms
	count       uint64   // histograms
}

func (r *Registry) register(name, help string, typ metricType, labels []string, buckets []float64) *family {
	if !metricNamePattern.MatchString(name) {
		panic(fmt.Sprintf("metrics: invalid metric name %q", name))
	}
	for _, l := range labels {
		if !labelNamePattern.MatchString(l) || strings.HasPrefix(l, "__") {
			panic(fmt.Sprintf("metrics: invalid label name %q for %s", l, name))
		}
		if typ == typeHistogram && l == "le" {
			panic(fmt.Sprintf("metrics: histogram %s cannot use the label le", name))
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, dup := r.byName[name]; dup {
		panic(fmt.Sprintf("metrics: %s registered twice", name))
	}
	f := &family{
		name:    name,
		help:    help,
		typ:     typ,
		labels:  slices.Clone(labels),
		buckets: buckets,
		series:  make(map[string]*series),
	}
	r.families = append(r.families, f)
	r.byName[name] = f
	return f
}

// with runs fn on the series for labelValues, creating it on first use.
func (f *family) with(labelValues []string, fn func(*series)) {
	if len(labelValues) != len(f.labels) {
		panic(fmt.Sprintf("metrics: %s takes %d label values, got %d", f.name, len(f.labels), len(labelValues)))
	}
	key := strings.Join(labelValues, "\xff")
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.series[key]
	if !ok {
		s = &series{labelValues: slices.Clone(labelValues)}
		if f.typ == typeHistogram {
			s.counts = make([]uint64, len(f.buckets))
		}
		f.series[key] = s
	}
	fn(s)
}

// Counter is a monotonically increasing value per label combination.
type Counter struct{ f *family }

// NewCounter registers a counter. It panics on an invalid or duplicate name.
func (r *Registry) NewCounter(name, help string, labels ...string) *Counter {
	return &Counter{f: r.register(name, help, typeCounter, labels, nil)}
}

// Inc adds one to the series for labelValues.
func (c *Counter) Inc(labelValues ...string) { c.Add(1, labelValues...) }

// Add adds v, which must not be negative, to the series for labelValues.
func (c *Counter) Add(v float64, labelValues ...string) {
	if v < 0 || math.IsNaN(v) {
		panic(fmt.Sprintf("metrics: counter %s cannot add %v", c.f.name, v))
	}
	c.f.with(labelValues, func(s *series) { s.value += v })
}

// Value returns the current value of the series for labelValues, or 0 if it was never touched.
func (c *Counter) Value(labelValues ...string) float64 { return c.f.value(labelValues) }

// Gauge is a value per label combination that can go up and down.
type Gauge struct{ f *family }

// NewGauge registers a gauge. It panics on an invalid or duplicate name.
func (r *Registry) NewGauge(name, help string, labels ...string) *Gauge {
	return &Gauge{f: r.register(name, help, typeGauge, labels, nil)}
}

// Set sets the series for labelValues to v.
func (g *Gauge) Set(v float64, labelValues ...string) {
	g.f.with(labelValues, func(s *series) { s.value = v })
}

// Add adds v (possibly negative) to the series for labelValues.
func (g *Gauge) Add(v float64, labelValues ...string) {
	g.f.with(labelValues, func(s *series) { s.value += v })
}

// Value returns the current value of the series for labelValues, or 0 if it was never touched.
func (g *Gauge) Value(labelValues ...string) float64 { return g.f.value(labelValues) }

// NewGaugeFunc registers a gauge without labels whose value is read from fn at each scrape.
// fn must be safe for concurrent use and fast; it runs while the scrape holds the family lock.
func (r *Registry) NewGaugeFunc(name, help string, fn func() float64) {
	f := r.register(name, help, typeGauge, nil, nil)
	f.read = fn
}

// Histogram counts observations in cumulative buckets per label combination.
type Histogram struct{ f *family }

// NewHistogram registers a histogram with the given upper bucket bounds, which must be sorted
// and distinct; nil means DefaultBuckets. The +Inf bucket is implicit.
func (r *Registry) NewHistogram(name, help string, buckets []float64, labels ...string) *Histogram {
	if buckets == nil {
		buckets = DefaultBuckets
	}
	for i := range buckets {
		if math.IsNaN(buckets[i]) || math.IsInf(buckets[i], 0) || (i > 0 && buckets[i] <= buckets[i-1]) {
			panic(fmt.Sprintf("metrics: histogram %s buckets must be finite and strictly increasing", name))
		}
	}
	return &Histogram{f: r.register(name, help, typeHistogram, labels, slices.Clone(buckets))}
}

// Observe records v in the series for labelValues.
func (h *Histogram) Observe(v float64, labelValues ...string) {
	h.f.with(labelValues, func(s *series) {
		// The first bucket whose upper bound is >= v; observations above every bound only
		// count towards +Inf, which is the total count.
		i, _ := slices.BinarySearch(h.f.buckets, v)
		if i < len(s.counts) {
			s.counts[i]++
		}
		s.sum += v
		s.count++
	})
}

// Count returns the number of observations in the series for labelValues.
func (h *Histogram) Count(labelValues ...string) uint64 {
	var n uint64
	h.f.peek(labelValues, func(s *series) { n = s.count })
	return n
}

func (f *family) value(labelValues []string) float64 {
	var v float64
	f.peek(labelValues, func(s *series) { v = s.value })
	return v
}

func (f *family) peek(labelValues []string, fn func(*series)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if s, ok := f.series[strings.Join(labelValues, "\xff")]; ok {
		fn(s)
	}
}
