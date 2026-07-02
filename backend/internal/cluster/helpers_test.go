package cluster

import (
	"k8s.io/apimachinery/pkg/version"
	"k8s.io/client-go/discovery"
	fakeclientset "k8s.io/client-go/kubernetes/fake"
)

// stubDiscovery embeds a real fake discovery and overrides ServerVersion so
// tests can control the Ping outcome (nil err = healthy, non-nil = unreachable).
type stubDiscovery struct {
	discovery.DiscoveryInterface
	err error
}

func (s stubDiscovery) ServerVersion() (*version.Info, error) {
	if s.err != nil {
		return nil, s.err
	}
	return &version.Info{GitVersion: "v1.31.0"}, nil
}

func newStubDiscovery(err error) stubDiscovery {
	return stubDiscovery{DiscoveryInterface: fakeclientset.NewSimpleClientset().Discovery(), err: err}
}
