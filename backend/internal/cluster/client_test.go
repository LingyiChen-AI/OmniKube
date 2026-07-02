package cluster

import (
	"errors"
	"testing"

	"k8s.io/apimachinery/pkg/version"
	"k8s.io/client-go/discovery"
	fakeclientset "k8s.io/client-go/kubernetes/fake"
)

// errDiscovery wraps a real fake discovery but forces ServerVersion to error,
// so we can exercise Ping's failure path without a real cluster.
type errDiscovery struct {
	discovery.DiscoveryInterface
}

func (errDiscovery) ServerVersion() (*version.Info, error) {
	return nil, errors.New("boom")
}

func TestPing_Success(t *testing.T) {
	cs := fakeclientset.NewSimpleClientset()
	c := &ClusterClient{Discovery: cs.Discovery()}
	if err := c.Ping(); err != nil {
		t.Fatalf("expected Ping to succeed, got %v", err)
	}
}

func TestPing_Failure(t *testing.T) {
	cs := fakeclientset.NewSimpleClientset()
	c := &ClusterClient{Discovery: errDiscovery{cs.Discovery()}}
	if err := c.Ping(); err == nil {
		t.Fatal("expected Ping to fail")
	}
}

func TestBuildClient_InvalidKubeconfig(t *testing.T) {
	if _, err := BuildClient("not a valid kubeconfig"); err == nil {
		t.Fatal("expected error for invalid kubeconfig")
	}
}

func TestBuildClient_Valid(t *testing.T) {
	const kc = `apiVersion: v1
kind: Config
clusters:
- name: test
  cluster:
    server: https://127.0.0.1:6443
contexts:
- name: test
  context:
    cluster: test
    user: test
current-context: test
users:
- name: test
  user:
    token: abc
`
	c, err := BuildClient(kc)
	if err != nil {
		t.Fatalf("expected valid kubeconfig to build, got %v", err)
	}
	if c.Typed == nil || c.Dynamic == nil || c.Discovery == nil || c.RESTMapper == nil || c.Config == nil {
		t.Fatalf("expected all client fields populated: %+v", c)
	}
}
