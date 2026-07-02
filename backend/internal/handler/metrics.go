package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// metrics.k8s.io GVR 是稳定的, 直连以绕过可能过期的 RESTMapper 缓存。
var (
	nodeMetricsGVR = schema.GroupVersionResource{Group: "metrics.k8s.io", Version: "v1beta1", Resource: "nodes"}
	podMetricsGVR  = schema.GroupVersionResource{Group: "metrics.k8s.io", Version: "v1beta1", Resource: "pods"}
	coreNodesGVR   = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "nodes"}
)

// milliCPU 解析 k8s CPU 数量为毫核(如 "429m"→429, "1"→1000)。
func milliCPU(q string) int64 {
	if qty, err := resource.ParseQuantity(q); err == nil {
		return qty.MilliValue()
	}
	return 0
}

// memBytes 解析 k8s 内存数量为字节(如 "1555Mi"→...)。
func memBytes(q string) int64 {
	if qty, err := resource.ParseQuantity(q); err == nil {
		return qty.Value()
	}
	return 0
}

func pct(used, cap int64) int {
	if cap <= 0 {
		return 0
	}
	return int(used * 100 / cap)
}

// MetricsAvailable GET /metrics/available —— 探测 metrics-server 是否就绪。
func (h *Handler) MetricsAvailable(c *gin.Context) {
	cc, ok := h.clusterClientFromHeader(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的 X-Cluster-ID"})
		return
	}
	_, err := cc.Dynamic.Resource(nodeMetricsGVR).List(c.Request.Context(), metav1.ListOptions{Limit: 1})
	c.JSON(http.StatusOK, gin.H{"available": err == nil})
}

type nodeMetric struct {
	Name        string `json:"name"`
	CPU         int64  `json:"cpu"`          // mCPU
	Memory      int64  `json:"memory"`       // bytes
	CPUCapacity int64  `json:"cpu_capacity"` // mCPU (allocatable)
	MemCapacity int64  `json:"mem_capacity"` // bytes (allocatable)
	CPUPct      int    `json:"cpu_pct"`
	MemPct      int    `json:"mem_pct"`
}

// NodeMetrics GET /metrics/nodes —— 各节点 CPU/内存用量与可分配量水位。
// metrics-server 缺失时返回 {available:false, nodes:[]}, 不报错。
func (h *Handler) NodeMetrics(c *gin.Context) {
	cc, ok := h.clusterClientFromHeader(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的 X-Cluster-ID"})
		return
	}
	ctx := c.Request.Context()
	usage, err := cc.Dynamic.Resource(nodeMetricsGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"available": false, "nodes": []nodeMetric{}})
		return
	}
	// 可分配量来自 core nodes.status.allocatable。
	capOf := map[string]struct{ cpu, mem int64 }{}
	if nodes, err := cc.Dynamic.Resource(coreNodesGVR).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range nodes.Items {
			n := &nodes.Items[i]
			cpu, _, _ := unstructured.NestedString(n.Object, "status", "allocatable", "cpu")
			mem, _, _ := unstructured.NestedString(n.Object, "status", "allocatable", "memory")
			capOf[n.GetName()] = struct{ cpu, mem int64 }{milliCPU(cpu), memBytes(mem)}
		}
	}
	out := make([]nodeMetric, 0, len(usage.Items))
	for i := range usage.Items {
		m := &usage.Items[i]
		cpuStr, _, _ := unstructured.NestedString(m.Object, "usage", "cpu")
		memStr, _, _ := unstructured.NestedString(m.Object, "usage", "memory")
		uCPU, uMem := milliCPU(cpuStr), memBytes(memStr)
		cp := capOf[m.GetName()]
		out = append(out, nodeMetric{
			Name: m.GetName(), CPU: uCPU, Memory: uMem,
			CPUCapacity: cp.cpu, MemCapacity: cp.mem,
			CPUPct: pct(uCPU, cp.cpu), MemPct: pct(uMem, cp.mem),
		})
	}
	c.JSON(http.StatusOK, gin.H{"available": true, "nodes": out})
}

type podMetric struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	CPU       int64  `json:"cpu"`    // mCPU
	Memory    int64  `json:"memory"` // bytes
}

// PodMetrics GET /metrics/pods?namespace= —— 各 Pod 的 CPU/内存用量(容器求和)。
func (h *Handler) PodMetrics(c *gin.Context) {
	cc, ok := h.clusterClientFromHeader(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的 X-Cluster-ID"})
		return
	}
	ctx := c.Request.Context()
	ri := cc.Dynamic.Resource(podMetricsGVR)
	var (
		items *unstructured.UnstructuredList
		err   error
	)
	if ns := c.Query("namespace"); ns != "" {
		items, err = ri.Namespace(ns).List(ctx, metav1.ListOptions{})
	} else {
		items, err = ri.List(ctx, metav1.ListOptions{})
	}
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"available": false, "pods": []podMetric{}})
		return
	}
	out := make([]podMetric, 0, len(items.Items))
	for i := range items.Items {
		p := &items.Items[i]
		containers, _, _ := unstructured.NestedSlice(p.Object, "containers")
		var cpu, mem int64
		for _, ci := range containers {
			cm, ok := ci.(map[string]interface{})
			if !ok {
				continue
			}
			cpuStr, _, _ := unstructured.NestedString(cm, "usage", "cpu")
			memStr, _, _ := unstructured.NestedString(cm, "usage", "memory")
			cpu += milliCPU(cpuStr)
			mem += memBytes(memStr)
		}
		out = append(out, podMetric{Namespace: p.GetNamespace(), Name: p.GetName(), CPU: cpu, Memory: mem})
	}
	c.JSON(http.StatusOK, gin.H{"available": true, "pods": out})
}
