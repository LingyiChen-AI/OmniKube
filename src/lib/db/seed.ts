import 'dotenv/config';
import { db } from './index';
import { users, roles, rolePermissions, userRoleBindings } from './schema';
import { hashPassword } from '@/lib/auth/password';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

const BUILT_IN_ROLES = [
  {
    name: 'super-admin', displayName: '超级管理员',
    description: '全局管理员，拥有所有权限',
    permissions: [{ resource: '*', actions: ['*'] }],
  },
  {
    name: 'cluster-admin', displayName: '集群管理员',
    description: '集群内所有资源的所有操作',
    permissions: [{ resource: '*', actions: ['*'] }],
  },
  {
    name: 'developer', displayName: '开发者',
    description: '可发布和查看常用资源',
    permissions: [
      { resource: 'deployments', actions: ['get', 'list', 'create', 'update', 'delete'] },
      { resource: 'services', actions: ['get', 'list', 'create', 'update', 'delete'] },
      { resource: 'configmaps', actions: ['get', 'list', 'create', 'update', 'delete'] },
      { resource: 'secrets', actions: ['get', 'list', 'create', 'update', 'delete'] },
      { resource: 'pods', actions: ['get', 'list', 'delete', 'logs', 'exec'] },
      { resource: 'ingresses', actions: ['get', 'list', 'create', 'update', 'delete'] },
    ],
  },
  {
    name: 'viewer', displayName: '只读用户',
    description: '所有资源的只读权限',
    permissions: [{ resource: '*', actions: ['get', 'list'] }],
  },
];

async function seed() {
  console.log('Seeding database...');
  for (const roleDef of BUILT_IN_ROLES) {
    const existing = await db.select().from(roles).where(eq(roles.name, roleDef.name)).limit(1);
    if (existing.length > 0) { console.log(`Role "${roleDef.name}" already exists, skipping.`); continue; }
    const [role] = await db.insert(roles).values({
      name: roleDef.name, displayName: roleDef.displayName,
      description: roleDef.description, isSystem: true,
    }).returning();
    for (const perm of roleDef.permissions) {
      await db.insert(rolePermissions).values({ roleId: role.id, resource: perm.resource, actions: perm.actions });
    }
    console.log(`Created role: ${roleDef.name}`);
  }

  const existingAdmin = await db.select().from(users).where(eq(users.username, 'admin')).limit(1);
  if (existingAdmin.length > 0) { console.log('Admin user already exists, skipping.'); return; }

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

  console.log('='.repeat(50));
  console.log('Admin account created:');
  console.log(`  Username: admin`);
  console.log(`  Password: ${adminPassword}`);
  console.log('  (Must change password on first login)');
  console.log('='.repeat(50));
}

seed()
  .then(() => { console.log('Seed complete.'); process.exit(0); })
  .catch((err) => { console.error('Seed failed:', err); process.exit(1); });
