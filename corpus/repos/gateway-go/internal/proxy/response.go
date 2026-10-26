package proxy

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"slices"
	"strings"

	"github.com/relaywork/gateway/internal/core"
)

// copyBufferSize is the size of the buffer responses are relayed through.
const copyBufferSize = 32 << 10

// respond relays the result of the last attempt: the upstream's response, or the gateway error
// that stands for its failure.
func (h *Handler) respond(w *statusRecorder, ex *exchange, res *attemptResult) {
	if res.err != nil {
		ex.err = res.err
		switch {
		case res.canceled:
			// The client is gone (or half-closed and still reading): abort the connection, so
			// that net/http does not send an empty response that looks like a success. The
			// deferred finish has logged and counted the request as 499 by then.
			panic(http.ErrAbortHandler)
		case res.class == core.ErrTimeout:
			h.fail(w, ex, newError(http.StatusGatewayTimeout, codeUpstreamTimeout, "the upstream did not respond in time"))
		default:
			h.fail(w, ex, newError(http.StatusBadGateway, codeUpstreamUnreachable, "the upstream could not be reached"))
		}
		return
	}
	defer res.release(nil)
	resp := res.resp
	defer resp.Body.Close()

	copyResponseHeader(w.Header(), resp.Header, ex.route)
	for name, values := range ex.headers {
		w.Header()[name] = values
	}
	announced := announceTrailers(w.Header(), relayedTrailer(resp.Trailer, resp.Header, ex.headers, ex.route))
	w.WriteHeader(resp.StatusCode)
	if ex.req.Method == http.MethodHead {
		return
	}
	if len(announced) > 0 {
		// Make net/http chunk the response, which trailers need, even when the body is short
		// enough for it to compute a length.
		if err := http.NewResponseController(w).Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
			ex.err = err
			panic(http.ErrAbortHandler) // the client is gone; do not end the response as complete
		}
	}

	readErr, writeErr := copyBody(w, resp.Body, flushesEachWrite(resp))
	switch {
	case writeErr != nil:
		// The client went away mid-response; stop reading from the upstream.
		ex.err = writeErr
	case readErr != nil && ex.req.Context().Err() != nil:
		// The client went away (or half-closed) and its cancellation ended the read from the
		// upstream. The upstream did nothing wrong, so nothing is logged against it; the
		// response is still aborted, since a half-closed client may read on and must not see
		// a truncated body end as if it were complete.
		ex.err = readErr
		panic(http.ErrAbortHandler)
	case readErr != nil:
		// The status line is already sent, so the client cannot be told with an error
		// response. Aborting the connection makes the truncation visible to it instead of
		// passing off a partial body as complete.
		ex.err = readErr
		h.log.Warn("upstream response broke off", "route", ex.route.ID, "upstream", ex.upstream.String(),
			"error", readErr, "request_id", ex.id)
		panic(http.ErrAbortHandler)
	default:
		setTrailers(w.Header(), relayedTrailer(resp.Trailer, resp.Header, ex.headers, ex.route), announced)
	}
}

// announceTrailers declares the trailer fields known before the body (filtered by
// relayedTrailer) in dst's Trailer field, before the header is written, and returns them.
func announceTrailers(dst, trailer http.Header) map[string]bool {
	if len(trailer) == 0 {
		return nil
	}
	keys := make([]string, 0, len(trailer))
	announced := make(map[string]bool, len(trailer))
	for k := range trailer {
		keys = append(keys, k)
		announced[k] = true
	}
	slices.Sort(keys)
	dst.Add("Trailer", strings.Join(keys, ", "))
	return announced
}

// setTrailers sets the trailer values (filtered by relayedTrailer), which are known once the
// upstream body has been read. Fields that were not announced are set with http.TrailerPrefix,
// which net/http sends as trailers without a declaration.
func setTrailers(dst, trailer http.Header, announced map[string]bool) {
	for k, values := range trailer {
		if announced[k] {
			dst[k] = values
		} else {
			dst[http.TrailerPrefix+k] = values
		}
	}
}

// flushesEachWrite reports whether the response is relayed without buffering: event streams,
// and bodies of unknown length, which are often streamed.
func flushesEachWrite(resp *http.Response) bool {
	if resp.ContentLength == -1 {
		return true
	}
	mediaType, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	return err == nil && mediaType == "text/event-stream"
}

// copyBody relays src to w, flushing after each write when flush is set. It returns the error
// that stopped it on either side.
func copyBody(w http.ResponseWriter, src io.Reader, flush bool) (readErr, writeErr error) {
	rc := http.NewResponseController(w)
	buf := make([]byte, copyBufferSize)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return nil, werr
			}
			if flush {
				if ferr := rc.Flush(); ferr != nil && !errors.Is(ferr, http.ErrNotSupported) {
					return nil, ferr
				}
			}
		}
		if errors.Is(err, io.EOF) {
			return nil, nil
		}
		if err != nil {
			return err, nil
		}
	}
}

// statusRecorder remembers the status code and body size of a response.
type statusRecorder struct {
	http.ResponseWriter
	status      int
	bytes       int64
	wroteHeader bool
}

func (r *statusRecorder) WriteHeader(code int) {
	if !r.wroteHeader {
		r.status = code
		r.wroteHeader = true
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytes += int64(n)
	return n, err
}

// Unwrap lets http.ResponseController reach the underlying writer, to flush it.
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }
