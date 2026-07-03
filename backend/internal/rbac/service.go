package rbac

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/casbin/casbin/v2"
	casbinmodel "github.com/casbin/casbin/v2/model"
	gormadapter "github.com/casbin/gorm-adapter/v3"
	"gorm.io/gorm"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"omnikube/internal/cluster"
	"omnikube/internal/model"
)

//go:embed model.conf
var modelConf string

// 预设角色名。
const (
	RoleClusterAdmin  = "Cluster-Admin"
	RoleClusterViewer = "Cluster-Viewer"
	RoleNSEditor      = "NS-Editor"
	RoleNSViewer      = "NS-Viewer"
)

// IsValidRole 校验角色是否为四种预设之一。
func IsValidRole(role string) bool {
	switch role {
	case RoleClusterAdmin, RoleClusterViewer, RoleNSEditor, RoleNSViewer:
		return true
	}
	return false
}

// IsClusterRole 判断角色是否集群范围（Cluster-*）。
func IsClusterRole(role string) bool {
	return role == RoleClusterAdmin || role == RoleClusterViewer
}

// IsNamespaceRole 判断角色是否命名空间范围（NS-*）。
func IsNamespaceRole(role string) bool {
	return role == RoleNSEditor || role == RoleNSViewer
}

// Grant 是解析后的角色绑定视图。
type Grant struct {
	Role      string `json:"role"`
	ClusterID string `json:"cluster_id"`
	Namespace string `json:"namespace"`
}

// Service 封装 casbin enforcer 与集群池，提供鉴权与角色绑定读写。
type Service struct {
	enforcer *casbin.Enforcer
	pool     *cluster.ClusterPool
	db       *gorm.DB
}

// NewService 建 adapter+enforcer，注册自定义匹配函数，幂等种子化预设角色。
func NewService(db *gorm.DB, pool *cluster.ClusterPool) (*Service, error) {
	// 复用既有的 casbin_rule 表（由 model.CasbinRule 创建）：用自定义表让
	// adapter 迁移并读写我们自己的结构体，确保只有一张一致的 casbin_rule 表。
	adapter, err := gormadapter.NewAdapterByDBWithCustomTable(db, &model.CasbinRule{})
	if err != nil {
		return nil, fmt.Errorf("casbin adapter 初始化失败: %w", err)
	}
	m, err := casbinmodel.NewModelFromString(modelConf)
	if err != nil {
		return nil, fmt.Errorf("casbin model 解析失败: %w", err)
	}
	e, err := casbin.NewEnforcer(m, adapter)
	if err != nil {
		return nil, fmt.Errorf("casbin enforcer 初始化失败: %w", err)
	}
	e.AddNamedDomainMatchingFunc("g", "domMatch", domMatch)
	e.AddFunction("resMatch", resMatchFunc)
	// 注册域匹配函数后重建角色链，使已加载的 g 绑定按 domMatch 生效。
	if err := e.BuildRoleLinks(); err != nil {
		return nil, fmt.Errorf("casbin 角色链构建失败: %w", err)
	}

	s := &Service{enforcer: e, pool: pool, db: db}
	if err := s.seedRoles(); err != nil {
		return nil, err
	}
	if err := s.seedPresetRoles(); err != nil {
		return nil, err
	}
	return s, nil
}

// 预设角色名（子项目 H §5），System=true, 启动幂等种子。
// 页面已改由操作权限派生（见 PagesFromOperations），故不再保留「仅见仪表盘」的审计员预设
// （其全组只读会派生出全部页面，与集群只读重复）。
// 预设角色名（中文为存储/回退值, 前端按 Key 做 i18n）。
const (
	PresetClusterAdmin  = "集群管理员"
	PresetClusterViewer = "集群只读"
	PresetDeveloper     = "开发者"
	PresetOperator      = "运维工程师"
	PresetReleaseMgr    = "发布管理员"
	PresetAuditor       = "审计员"
)

// 预设角色稳定标识(Key)，前端 i18n 用。
const (
	KeyClusterAdmin  = "cluster-admin"
	KeyClusterViewer = "cluster-viewer"
	KeyDeveloper     = "developer"
	KeyOperator      = "operator"
	KeyReleaseMgr    = "release-manager"
	KeyAuditor       = "auditor"
)

// resourceActions 返回某资源适用的全部树动作（view/create/edit/delete/exec/reveal）。
func resourceActions(res string) []string {
	acts := []string{}
	for _, ta := range []string{"view", "create", "edit", "delete", "exec", "reveal"} {
		if ResourceActionApplies(res, ta) {
			acts = append(acts, ta)
		}
	}
	return acts
}

// seedPresetRoles 幂等种子化预设角色（DB 行）。按名缺失才建, 已存在不覆盖（允许 admin 编辑），
// 但会回填缺失的 Key（供旧库升级后前端 i18n）。
// v3：operations 按具体资源（AllResources）组织, 值为该资源适用的树动作集合；
// 全局权限存于 Role.GlobalPerms（区域→动作 JSON）。
func (s *Service) seedPresetRoles() error {
	adminOps := map[string][]string{}   // 全部资源全部动作
	viewOps := map[string][]string{}    // 全部资源仅 view
	developerOps := map[string][]string{} // 工作负载/网络/存储全权, 节点只读
	releaseOps := map[string][]string{} // 工作负载 view+edit
	for _, res := range AllResources {
		adminOps[res] = resourceActions(res)
		viewOps[res] = []string{"view"}
	}
	for mod, rs := range moduleResources {
		for _, res := range rs {
			if mod == "nodes" {
				developerOps[res] = []string{"view"}
			} else {
				developerOps[res] = resourceActions(res)
			}
		}
	}
	for _, res := range moduleResources["workloads"] {
		releaseOps[res] = []string{"view", "edit"}
	}

	adminGlobal := AllGlobalPerms()
	viewGlobal := map[string][]string{"releases": {"view"}}
	// 运维：集群管理 + 发布记录, 但不含用户/角色管理。
	operatorGlobal := map[string][]string{
		"clusters": {"view", "create", "edit", "delete"},
		"releases": {"view"},
	}
	// 审计员：仅审计日志 + 发布记录只读, 无资源与系统管理权限。
	auditorGlobal := map[string][]string{
		"audit":    {"view"},
		"releases": {"view"},
	}

	presets := []struct {
		key, name, desc string
		ops             map[string][]string
		global          map[string][]string
	}{
		{KeyClusterAdmin, PresetClusterAdmin, "对所有集群拥有全部操作权限,以及集群、用户、角色与发布记录的管理权限。", adminOps, adminGlobal},
		{KeyClusterViewer, PresetClusterViewer, "对所有集群所有资源只读,可查看发布记录。", viewOps, viewGlobal},
		{KeyDeveloper, PresetDeveloper, "管理工作负载、网络与存储(含容器终端、查看密钥),节点只读;不含系统管理。", developerOps, viewGlobal},
		{KeyOperator, PresetOperator, "对所有资源拥有全部操作权限,并可管理集群与发布记录,但不含用户与角色管理。", adminOps, operatorGlobal},
		{KeyReleaseMgr, PresetReleaseMgr, "查看并更新工作负载(用于镜像发布),可查看发布记录。", releaseOps, viewGlobal},
		{KeyAuditor, PresetAuditor, "查看审计日志与发布记录, 不含任何资源与系统管理权限。", map[string][]string{}, auditorGlobal},
	}
	for _, p := range presets {
		var existing model.Role
		err := s.db.Where("name = ?", p.name).First(&existing).Error
		if err == nil {
			// 已存在：仅回填缺失的 Key,不覆盖 admin 的编辑。
			if existing.Key == "" {
				if e := s.db.Model(&existing).Update("key", p.key).Error; e != nil {
					return e
				}
			}
			continue
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		opsJSON, _ := json.Marshal(p.ops)
		globalJSON, _ := json.Marshal(p.global)
		role := model.Role{Name: p.name, Description: p.desc, Key: p.key, System: true, GlobalPerms: string(globalJSON)}
		if err := s.db.Create(&role).Error; err != nil {
			return err
		}
		rule := model.RoleRule{RoleID: role.ID, ClusterID: "*", Scope: "cluster", Operations: string(opsJSON)}
		if err := s.db.Create(&rule).Error; err != nil {
			return err
		}
	}
	return nil
}

// seedRoles 幂等种子化四种内置级别的 p 策略（子项目 G 兼容用, 物化已改走合成角色）。
// 保留无害, 供按 level 直接 AddGrant 的旧路径/测试使用。AddPolicy 已存在则跳过。
func (s *Service) seedRoles() error {
	policies := [][]string{
		{RoleClusterAdmin, "*", "*", "*"},
		{RoleClusterViewer, "*", "*", "read"},
		{RoleNSEditor, "*", "*", "read"},
		{RoleNSEditor, "*", "workloads", "create"},
		{RoleNSEditor, "*", "workloads", "write"},
		{RoleNSEditor, "*", "workloads", "delete"},
		{RoleNSEditor, "*", "network", "create"},
		{RoleNSEditor, "*", "network", "write"},
		{RoleNSEditor, "*", "network", "delete"},
		{RoleNSEditor, "*", "config", "create"},
		{RoleNSEditor, "*", "config", "write"},
		{RoleNSEditor, "*", "config", "delete"},
		{RoleNSEditor, "*", "config", "reveal"},
		{RoleNSEditor, "*", "pods", "exec"},
		{RoleNSViewer, "*", "*", "read"},
	}
	for _, p := range policies {
		if _, err := s.enforcer.AddPolicy(p); err != nil {
			return fmt.Errorf("种子角色策略失败 %v: %w", p, err)
		}
	}
	return nil
}

// domainOf 按 PRD §7 构造请求域：namespace=="" 为集群级域，否则命名空间级域。
func domainOf(clusterID, namespace string) string {
	if namespace == "" {
		return clusterID
	}
	return clusterID + ":" + namespace
}

// Authorize 实现 PRD §7 的鉴权裁决（不含 namespace 解析，那在 D）。
// 返回 (allowed, visibleNS, err)。
func (s *Service) Authorize(userID, clusterID, namespace, resource, action string) (bool, []string, error) {
	// 系统管理员旁路：与 HTTP RBAC 中间件(middleware/rbac.go)一致，is_admin 用户
	// 不经 casbin 策略而直接放行。直接调用 Authorize 的路径（如 AI 助手双闸门 Guard）
	// 没有中间件的旁路，故必须在此统一体现，否则 admin 会被误判为无任何权限。
	if admin, err := s.isAdminUser(userID); err != nil {
		return false, nil, err
	} else if admin {
		return true, nil, nil
	}
	dom := domainOf(clusterID, namespace)
	ok, err := s.enforcer.Enforce(userID, dom, resource, action)
	if err != nil {
		return false, nil, err
	}
	if ok {
		return true, nil, nil
	}
	// 受控集群级只读：集群级请求 + read + 可聚合资源。把可见 NS 过滤为「用户在该 NS
	// 上对本资源确有 read」的子集，避免越权——例如无 config read 的角色不能借集群级聚合
	// 读到 ConfigMap/Secret；而 Cluster-Viewer（含 config read）仍可见全部命名空间。
	if isClusterScope(namespace) && action == "read" && isAggregatableRead(resource) {
		visible, err := s.ListVisibleNamespaces(userID, clusterID)
		if err != nil {
			return false, nil, err
		}
		allowed := make([]string, 0, len(visible))
		for _, ns := range visible {
			ok, err := s.enforcer.Enforce(userID, domainOf(clusterID, ns), resource, "read")
			if err != nil {
				return false, nil, err
			}
			if ok {
				allowed = append(allowed, ns)
			}
		}
		if len(allowed) > 0 {
			return true, allowed, nil
		}
	}
	return false, nil, nil
}

// isAdminUser 判断 userID 是否系统管理员。记录不存在按非 admin 处理（走 casbin）；
// 其它 DB 错误上抛，让调用方 fail-closed。
func (s *Service) isAdminUser(userID string) (bool, error) {
	id, err := strconv.ParseUint(userID, 10, 64)
	if err != nil {
		return false, nil // 非数字 subject（不该出现）→ 交给 casbin。
	}
	var u model.User
	err = s.db.Select("is_admin").First(&u, uint(id)).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return u.IsAdmin, nil
}

// ListVisibleNamespaces 列出用户在某集群可见的命名空间。
// 集群级角色 → 该集群全部 NS（经 pool 列举）；否则其 g 绑定中 "clusterID:ns" 的 ns 集合。
func (s *Service) ListVisibleNamespaces(userID, clusterID string) ([]string, error) {
	grouping, err := s.enforcer.GetFilteredGroupingPolicy(0, userID)
	if err != nil {
		return nil, err
	}
	clusterLevel := false
	nsSet := map[string]bool{}
	prefix := clusterID + ":"
	for _, g := range grouping {
		if len(g) < 3 {
			continue
		}
		dom := g[2]
		if dom == clusterID || dom == "*" {
			// "*" 为 cluster:"*" 规则的通配域, 覆盖任意集群（含本集群）的全部 NS。
			clusterLevel = true
		} else if strings.HasPrefix(dom, prefix) {
			nsSet[strings.TrimPrefix(dom, prefix)] = true
		}
	}
	if clusterLevel {
		return s.listAllNamespaces(clusterID)
	}
	out := make([]string, 0, len(nsSet))
	for ns := range nsSet {
		out = append(out, ns)
	}
	sort.Strings(out)
	return out, nil
}

// listAllNamespaces 经 pool 的 ClusterClient 列举该集群全部命名空间名。
func (s *Service) listAllNamespaces(clusterID string) ([]string, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("集群池未初始化")
	}
	cc, ok := s.pool.Get(clusterID)
	if !ok {
		return nil, fmt.Errorf("集群 %s 不在连接池", clusterID)
	}
	list, err := cc.Typed.CoreV1().Namespaces().List(context.Background(), metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(list.Items))
	for _, ns := range list.Items {
		out = append(out, ns.Name)
	}
	sort.Strings(out)
	return out, nil
}

// AddGrant 写一条 g 绑定。
func (s *Service) AddGrant(userID, role, domain string) error {
	_, err := s.enforcer.AddGroupingPolicy(userID, role, domain)
	return err
}

// RemoveGrant 删一条 g 绑定。
func (s *Service) RemoveGrant(userID, role, domain string) error {
	_, err := s.enforcer.RemoveGroupingPolicy(userID, role, domain)
	return err
}

// ListGrants 列该用户全部 g 绑定（解析 domain 成 cluster/ns）。
func (s *Service) ListGrants(userID string) ([]Grant, error) {
	grouping, err := s.enforcer.GetFilteredGroupingPolicy(0, userID)
	if err != nil {
		return nil, err
	}
	out := make([]Grant, 0, len(grouping))
	for _, g := range grouping {
		if len(g) < 3 {
			continue
		}
		role, dom := g[1], g[2]
		clusterID, namespace := dom, ""
		if i := strings.IndexByte(dom, ':'); i >= 0 {
			clusterID, namespace = dom[:i], dom[i+1:]
		}
		out = append(out, Grant{Role: role, ClusterID: clusterID, Namespace: namespace})
	}
	return out, nil
}

// RemoveClusterPolicies 删所有 domain 命中该集群的 g（集群级 + 该集群全部 NS 级）。
func (s *Service) RemoveClusterPolicies(clusterID string) error {
	grouping, err := s.enforcer.GetGroupingPolicy()
	if err != nil {
		return err
	}
	prefix := clusterID + ":"
	var toRemove [][]string
	for _, g := range grouping {
		if len(g) < 3 {
			continue
		}
		dom := g[2]
		if dom == clusterID || strings.HasPrefix(dom, prefix) {
			toRemove = append(toRemove, g)
		}
	}
	if len(toRemove) == 0 {
		return nil
	}
	_, err = s.enforcer.RemoveGroupingPolicies(toRemove)
	return err
}

// RemoveUserGrants 删 v0==userID 的全部 g。
func (s *Service) RemoveUserGrants(userID string) error {
	_, err := s.enforcer.RemoveFilteredGroupingPolicy(0, userID)
	return err
}

// subjectOf 把数值用户 ID 转成 casbin subject 字符串。
func subjectOf(userID uint) string {
	return strconv.FormatUint(uint64(userID), 10)
}

// SyncUserGrants 用「用户当前所有角色的规则」重建该用户的 casbin g 绑定（子项目 H 物化核心）。
// 先清空该用户全部 g，再把每条规则的「操作集合」物化为合成角色 perm:<sig> 并绑定：
//   - 合成角色按 operations 的规范签名去重, 其 p 策略幂等建立。
//   - scope=cluster   → AddGrant(uid, synth, clusterID)（clusterID 可为 "*"）
//   - scope=namespace → 每个 ns 一行 AddGrant(uid, synth, clusterID+":"+ns)
//
// 多角色的重复绑定由 casbin 去重（AddGroupingPolicy 命中已存在则跳过）。
func (s *Service) SyncUserGrants(userID uint) error {
	uid := subjectOf(userID)
	if err := s.RemoveUserGrants(uid); err != nil {
		return err
	}
	var roleIDs []uint
	if err := s.db.Model(&model.UserRole{}).Where("user_id = ?", userID).Pluck("role_id", &roleIDs).Error; err != nil {
		return err
	}
	if len(roleIDs) == 0 {
		return nil
	}
	var rules []model.RoleRule
	if err := s.db.Where("role_id IN ?", roleIDs).Find(&rules).Error; err != nil {
		return err
	}
	for _, rule := range rules {
		ops := parseOperations(rule.Operations)
		synth := syntheticRole(ops)
		// 幂等建合成角色的 p 策略：对每个 (resource, treeAction) AddPolicy(synth,"*",resource,casbinAction)。
		// v3：operations 按具体资源（如 "deployments"/"pods"）而非资源组组织；树动作经
		// actionToCasbin 映射为 casbin 动作（view→read, edit→write, 其余同名）。
		// 相同操作集合复用同一合成角色, 多用户/多角色共享其 p 策略。
		for _, resource := range sortedGroups(ops) {
			for _, ta := range dedupSortedActions(ops[resource]) {
				if _, err := s.enforcer.AddPolicy(synth, "*", resource, actionToCasbin(ta)); err != nil {
					return err
				}
			}
		}
		// 域展开：cluster 范围 → [clusterID]（可为 "*"）；namespace 范围 → 每个 ns 一域。
		var domains []string
		switch rule.Scope {
		case "cluster":
			domains = []string{rule.ClusterID}
		case "namespace":
			for _, ns := range parseNamespaces(rule.Namespaces) {
				domains = append(domains, rule.ClusterID+":"+ns)
			}
		}
		for _, d := range domains {
			if err := s.AddGrant(uid, synth, d); err != nil {
				return err
			}
		}
	}
	return nil
}

// parseNamespaces 解析 RoleRule.Namespaces 的 JSON 数组字符串，非法/空返回空切片。
func parseNamespaces(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out []string
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil
	}
	return out
}

// UsersForRole 返回绑定了指定角色的全部用户 ID。
func (s *Service) UsersForRole(roleID uint) ([]uint, error) {
	var ids []uint
	err := s.db.Model(&model.UserRole{}).Where("role_id = ?", roleID).Pluck("user_id", &ids).Error
	return ids, err
}

// SyncRoleUsers 对绑定了某角色的所有用户逐个重物化（编辑角色规则后调用）。
func (s *Service) SyncRoleUsers(roleID uint) error {
	ids, err := s.UsersForRole(roleID)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := s.SyncUserGrants(id); err != nil {
			return err
		}
	}
	return nil
}

// OnClusterDeleted 集群删除后的级联（须在集群行删除事务提交之后调用）：
// 找出受影响用户 → 删该集群的 role_rules → RemoveClusterPolicies（保险）→ 受影响用户重物化。
func (s *Service) OnClusterDeleted(clusterID string) error {
	var roleIDs []uint
	if err := s.db.Model(&model.RoleRule{}).Where("cluster_id = ?", clusterID).
		Distinct().Pluck("role_id", &roleIDs).Error; err != nil {
		return err
	}
	affected := map[uint]bool{}
	if len(roleIDs) > 0 {
		var uids []uint
		if err := s.db.Model(&model.UserRole{}).Where("role_id IN ?", roleIDs).
			Pluck("user_id", &uids).Error; err != nil {
			return err
		}
		for _, u := range uids {
			affected[u] = true
		}
	}
	if err := s.db.Where("cluster_id = ?", clusterID).Delete(&model.RoleRule{}).Error; err != nil {
		return err
	}
	if err := s.RemoveClusterPolicies(clusterID); err != nil {
		return err
	}
	for u := range affected {
		if err := s.SyncUserGrants(u); err != nil {
			return err
		}
	}
	return nil
}
