/**
 * 判断一个 K8s 资源是否为系统资源（不应被编辑/删除）
 * - namespace 资源本身：default 或 kube-* 开头
 * - 普通资源：所在命名空间以 kube- 开头
 */
export function isSystemResource(record: any): boolean {
  const ns = record.metadata?.namespace;
  const name = record.metadata?.name;

  // For namespace resources (no namespace field, just name)
  if (!ns && name) {
    return name === 'default' || name.startsWith('kube-');
  }

  // For namespaced resources — only kube-* namespaces are protected
  if (ns) {
    return ns.startsWith('kube-');
  }

  return false;
}
