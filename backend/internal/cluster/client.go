package cluster

import (
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/client-go/discovery"
	memory "k8s.io/client-go/discovery/cached/memory"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/restmapper"
	"k8s.io/client-go/tools/clientcmd"
)

// ClusterClient 聚合单个 K8S 集群的一组 client-go 客户端。
// 使用接口类型（kubernetes.Interface / dynamic.Interface / discovery.DiscoveryInterface）
// 以便单测注入 fake 实现，无需真实集群。
type ClusterClient struct {
	Typed      kubernetes.Interface
	Dynamic    dynamic.Interface
	Discovery  discovery.DiscoveryInterface
	RESTMapper meta.RESTMapper
	Config     *rest.Config
}

// Ping 连通性探测，调用 Discovery.ServerVersion()。
func (c *ClusterClient) Ping() error {
	_, err := c.Discovery.ServerVersion()
	return err
}

// ClientBuilder 抽象客户端构建，生产用 BuildClient，单测注入 fake。
type ClientBuilder func(kubeconfig string) (*ClusterClient, error)

// BuildClient 从 kubeconfig 文本构建整套客户端（生产实现）。
func BuildClient(kubeconfig string) (*ClusterClient, error) {
	cfg, err := clientcmd.RESTConfigFromKubeConfig([]byte(kubeconfig))
	if err != nil {
		return nil, err
	}
	typed, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	disco, err := discovery.NewDiscoveryClientForConfig(cfg)
	if err != nil {
		return nil, err
	}
	mapper := restmapper.NewDeferredDiscoveryRESTMapper(memory.NewMemCacheClient(disco))
	return &ClusterClient{
		Typed:      typed,
		Dynamic:    dyn,
		Discovery:  disco,
		RESTMapper: mapper,
		Config:     cfg,
	}, nil
}
