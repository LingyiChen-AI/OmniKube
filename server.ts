import 'dotenv/config';
import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3000');

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

async function autoSeed() {
  try {
    const { db } = await import('./src/lib/db/index');
    const { users, roles, rolePermissions, userRoleBindings } = await import('./src/lib/db/schema');
    const { eq } = await import('drizzle-orm');
    const { hashPassword } = await import('./src/lib/auth/password');
    const crypto = await import('crypto');

    // Check if admin user exists
    const existingAdmin = await db.select().from(users).where(eq(users.username, 'admin')).limit(1);
    if (existingAdmin.length > 0) return;

    // Seed built-in roles
    const BUILT_IN_ROLES = [
      { name: 'super-admin', displayName: '超级管理员', description: '全局管理员，拥有所有权限', permissions: [{ resource: '*', actions: ['*'] }] },
      { name: 'cluster-admin', displayName: '集群管理员', description: '集群内所有资源的所有操作', permissions: [{ resource: '*', actions: ['*'] }] },
      { name: 'developer', displayName: '开发者', description: '可发布和查看常用资源', permissions: [
        { resource: 'deployments', actions: ['get', 'list', 'create', 'update', 'delete'] },
        { resource: 'services', actions: ['get', 'list', 'create', 'update', 'delete'] },
        { resource: 'configmaps', actions: ['get', 'list', 'create', 'update', 'delete'] },
        { resource: 'secrets', actions: ['get', 'list', 'create', 'update', 'delete'] },
        { resource: 'pods', actions: ['get', 'list', 'delete', 'logs', 'exec'] },
        { resource: 'ingresses', actions: ['get', 'list', 'create', 'update', 'delete'] },
      ]},
      { name: 'viewer', displayName: '只读用户', description: '所有资源的只读权限', permissions: [{ resource: '*', actions: ['get', 'list'] }] },
    ];

    for (const roleDef of BUILT_IN_ROLES) {
      const existing = await db.select().from(roles).where(eq(roles.name, roleDef.name)).limit(1);
      if (existing.length > 0) continue;
      const [role] = await db.insert(roles).values({
        name: roleDef.name, displayName: roleDef.displayName,
        description: roleDef.description, isSystem: true,
      }).returning();
      for (const perm of roleDef.permissions) {
        await db.insert(rolePermissions).values({ roleId: role.id, resource: perm.resource, actions: perm.actions });
      }
    }

    // Create admin user
    const adminPassword = crypto.randomBytes(8).toString('hex');
    const passwordHash = await hashPassword(adminPassword);
    const [adminUser] = await db.insert(users).values({
      username: 'admin', email: 'admin@k8sadmin.local',
      passwordHash, mustChangePassword: true,
    }).returning();

    const [superAdminRole] = await db.select().from(roles).where(eq(roles.name, 'super-admin')).limit(1);
    await db.insert(userRoleBindings).values({
      userId: adminUser.id, roleId: superAdminRole.id, createdBy: adminUser.id,
    });

    console.log('');
    console.log('='.repeat(50));
    console.log('  Admin account created:');
    console.log(`    Username: admin`);
    console.log(`    Password: ${adminPassword}`);
    console.log('    (Must change password on first login)');
    console.log('='.repeat(50));
    console.log('');
  } catch (err) {
    // DB not ready or already seeded — skip silently
    console.error('Auto-seed skipped:', (err as Error).message);
  }
}

app.prepare().then(async () => {
  // Auto-seed on first startup
  await autoSeed();

  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url || '', true);
    handle(req, res, parsedUrl);
  });

  // Attach WebSocket server to the same HTTP server
  const { startWsServer } = await import('./src/lib/ws/server');
  startWsServer(server);

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log(`> WebSocket attached to the same server`);
  });
});
