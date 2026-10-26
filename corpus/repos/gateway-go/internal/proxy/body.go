package proxy

import (
	"bytes"
	"errors"
	"io"
	"net/http"
)

// errBodyTooLarge reports a body that had to be held in memory but exceeds the buffer limit.
var errBodyTooLarge = errors.New("request body exceeds the buffer limit")

// requestBody is the body of a request as the forwarding loop sees it: either held in memory,
// so that every attempt can send it again, or a stream that only one attempt can send.
type requestBody struct {
	buf        []byte    // the complete body, when replayable
	replayable bool      // whether buf holds the complete body
	stream     io.Reader // the body to send once, when not replayable
	length     int64     // the stream's length, -1 when unknown
}

// noBody is a request without a body. It is trivially replayable.
var noBody = &requestBody{replayable: true}

// hasBody reports whether the request carries a body.
func hasBody(r *http.Request) bool {
	return r.Body != nil && r.Body != http.NoBody && r.ContentLength != 0
}

// bufferBody reads the whole body into memory, failing with errBodyTooLarge when it is longer
// than limit. Authentication modes that sign the body need it.
func bufferBody(r *http.Request, limit int64) (*requestBody, error) {
	if !hasBody(r) {
		return noBody, nil
	}
	if r.ContentLength > limit {
		return nil, errBodyTooLarge
	}
	buf, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(buf)) > limit {
		return nil, errBodyTooLarge
	}
	return &requestBody{buf: buf, replayable: true}, nil
}

// retryableBody reads the body into memory when it fits within limit, so that a failed attempt
// can be retried. A longer body is streamed instead, and the request is sent once: a body whose
// declared length exceeds the limit is not read at all, and one of unknown length that turns out
// too long is sent as the part already read followed by the rest.
func retryableBody(r *http.Request, limit int64) (*requestBody, error) {
	if !hasBody(r) {
		return noBody, nil
	}
	if r.ContentLength > limit {
		return &requestBody{stream: r.Body, length: r.ContentLength}, nil
	}
	buf, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(buf)) <= limit {
		return &requestBody{buf: buf, replayable: true}, nil
	}
	return &requestBody{stream: io.MultiReader(bytes.NewReader(buf), r.Body), length: r.ContentLength}, nil
}

// streamBody passes the body through without reading it.
func streamBody(r *http.Request) *requestBody {
	if !hasBody(r) {
		return noBody
	}
	return &requestBody{stream: r.Body, length: r.ContentLength}
}

// forAttempt returns the body and content length for one attempt. A stream can be handed out
// only once; later calls return ok false.
func (b *requestBody) forAttempt() (body io.ReadCloser, length int64, ok bool) {
	if b.replayable {
		if len(b.buf) == 0 {
			return nil, 0, true
		}
		return io.NopCloser(bytes.NewReader(b.buf)), int64(len(b.buf)), true
	}
	if b.stream == nil {
		return nil, 0, false
	}
	s := b.stream
	b.stream = nil
	return io.NopCloser(s), b.length, true
}

// content returns the buffered body for authenticators that sign it, nil for a stream.
func (b *requestBody) content() []byte {
	if b.replayable {
		return b.buf
	}
	return nil
}
