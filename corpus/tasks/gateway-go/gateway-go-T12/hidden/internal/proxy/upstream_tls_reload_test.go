package proxy

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/relaywork/gateway/internal/config"
)

// reloadPKI signs the certificates of the reload test: one authority, a server certificate for
// the upstream and client certificates the gateway presents.
type reloadPKI struct {
	t    *testing.T
	ca   *x509.Certificate
	key  *ecdsa.PrivateKey
	caPM []byte
	dir  string
}

func newReloadPKI(t *testing.T) *reloadPKI {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(10), Subject: pkix.Name{CommonName: "reload CA"},
		NotBefore: time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC), NotAfter: time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	p := &reloadPKI{t: t, ca: ca, key: key, dir: t.TempDir()}
	p.caPM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	p.writeFile("ca.pem", p.caPM)
	return p
}

func (p *reloadPKI) writeFile(name string, data []byte) string {
	p.t.Helper()
	path := filepath.Join(p.dir, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		p.t.Fatal(err)
	}
	return path
}

// leaf issues a certificate under the authority with the given usage and writes it to
// client.pem and client.key (or server pair when usage is server auth), returning the tls pair.
func (p *reloadPKI) leaf(name string, usage x509.ExtKeyUsage, serial int64) tls.Certificate {
	p.t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		p.t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC), NotAfter: time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{usage},
		IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1)},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, p.ca, &key.PublicKey, p.key)
	if err != nil {
		p.t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		p.t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		p.t.Fatal(err)
	}
	p.writeFile("client.crt", certPEM)
	p.writeFile("client.key", keyPEM)
	return pair
}

// TestUpstreamTLSSurvivesReload checks that a route with TLS settings keeps working across
// reloads: unchanged settings, a route that comes and goes, and a rotated client certificate
// read from the same paths.
func TestUpstreamTLSSurvivesReload(t *testing.T) {
	p := newReloadPKI(t)
	serverPair := p.leaf("upstream", x509.ExtKeyUsageServerAuth, 11)
	p.leaf("gateway", x509.ExtKeyUsageClientAuth, 12)

	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(p.caPM)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(r.TLS.PeerCertificates[0].Subject.CommonName))
	}))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{serverPair}, ClientCAs: pool, ClientAuth: tls.RequireAndVerifyClientCert}
	srv.StartTLS()
	t.Cleanup(srv.Close)

	caPath := filepath.Join(p.dir, "ca.pem")
	certPath := filepath.Join(p.dir, "client.crt")
	keyPath := filepath.Join(p.dir, "client.key")
	secure := `{"id":"secure","path":"/secure","upstreams":[{"url":"` + srv.URL + `"}],
		"tls":{"ca_file":"` + caPath + `","cert_file":"` + certPath + `","key_file":"` + keyPath + `"}}`
	plain := `{"id":"plain","path":"/plain","upstreams":[{"url":"http://127.0.0.1:1"}]}`

	f := newFixture(t, `{"routes":[`+secure+`]}`, fixtureOptions{transport: &http.Transport{}})
	get := func(path string) *httptest.ResponseRecorder {
		t.Helper()
		return f.get(path)
	}
	if w := get("/secure"); w.Code != http.StatusOK || w.Body.String() != "gateway" {
		t.Fatalf("before reload: %d %q", w.Code, w.Body.String())
	}

	reload := func(body string) {
		t.Helper()
		routes, err := config.ParseRoutes([]byte(`{"routes":[` + body + `]}`))
		if err != nil {
			t.Fatal(err)
		}
		if err := f.rt.Apply(routes); err != nil {
			t.Fatal(err)
		}
	}
	reload(secure)
	if w := get("/secure"); w.Code != http.StatusOK {
		t.Fatalf("after a reload with the same settings: %d", w.Code)
	}

	reload(plain + "," + secure)
	if w := get("/secure"); w.Code != http.StatusOK {
		t.Fatalf("after adding a plain route: %d", w.Code)
	}

	// Rotate the client certificate on the same paths and reload: the gateway presents the new one.
	p.leaf("gateway-rotated", x509.ExtKeyUsageClientAuth, 13)
	reload(secure)
	if w := get("/secure"); w.Code != http.StatusOK || w.Body.String() != "gateway-rotated" {
		t.Fatalf("after rotating the client certificate: %d %q", w.Code, w.Body.String())
	}
}
