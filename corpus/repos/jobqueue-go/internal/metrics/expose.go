package metrics

import (
	"bufio"
	"io"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
)

// ContentType is the media type of the text exposition format.
const ContentType = "text/plain; version=0.0.4; charset=utf-8"

// WriteText writes every family in the text exposition format. Families appear in registration
// order and series in label-value order, so the output is stable between scrapes.
func (r *Registry) WriteText(w io.Writer) error {
	r.mu.Lock()
	families := slices.Clone(r.families)
	r.mu.Unlock()

	bw := bufio.NewWriter(w)
	for _, f := range families {
		f.write(bw)
	}
	return bw.Flush()
}

// Handler serves the registry in the text exposition format.
func (r *Registry) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", ContentType)
		// A failed write means the scraper went away; there is nobody left to tell.
		_ = r.WriteText(w)
	})
}

func (f *family) write(w *bufio.Writer) {
	f.mu.Lock()
	defer f.mu.Unlock()

	w.WriteString("# HELP " + f.name + " " + escapeHelp(f.help) + "\n")
	w.WriteString("# TYPE " + f.name + " " + string(f.typ) + "\n")
	if f.read != nil {
		writeSample(w, f.name, nil, nil, "", "", f.read())
		return
	}

	keys := make([]string, 0, len(f.series))
	for k := range f.series {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		s := f.series[k]
		if f.typ != typeHistogram {
			writeSample(w, f.name, f.labels, s.labelValues, "", "", s.value)
			continue
		}
		var cumulative uint64
		for i, bound := range f.buckets {
			cumulative += s.counts[i]
			writeSample(w, f.name+"_bucket", f.labels, s.labelValues, "le", formatFloat(bound), float64(cumulative))
		}
		writeSample(w, f.name+"_bucket", f.labels, s.labelValues, "le", "+Inf", float64(s.count))
		writeSample(w, f.name+"_sum", f.labels, s.labelValues, "", "", s.sum)
		writeSample(w, f.name+"_count", f.labels, s.labelValues, "", "", float64(s.count))
	}
}

func writeSample(w *bufio.Writer, name string, labels, values []string, extraLabel, extraValue string, v float64) {
	w.WriteString(name)
	if len(labels) > 0 || extraLabel != "" {
		w.WriteByte('{')
		for i, l := range labels {
			if i > 0 {
				w.WriteByte(',')
			}
			w.WriteString(l + `="` + escapeLabelValue(values[i]) + `"`)
		}
		if extraLabel != "" {
			if len(labels) > 0 {
				w.WriteByte(',')
			}
			w.WriteString(extraLabel + `="` + extraValue + `"`)
		}
		w.WriteByte('}')
	}
	w.WriteByte(' ')
	w.WriteString(formatFloat(v))
	w.WriteByte('\n')
}

func formatFloat(v float64) string {
	switch {
	case math.IsInf(v, 1):
		return "+Inf"
	case math.IsInf(v, -1):
		return "-Inf"
	case math.IsNaN(v):
		return "NaN"
	}
	return strconv.FormatFloat(v, 'g', -1, 64)
}

var (
	helpEscaper  = strings.NewReplacer(`\`, `\\`, "\n", `\n`)
	labelEscaper = strings.NewReplacer(`\`, `\\`, "\n", `\n`, `"`, `\"`)
)

func escapeHelp(s string) string       { return helpEscaper.Replace(s) }
func escapeLabelValue(s string) string { return labelEscaper.Replace(s) }
