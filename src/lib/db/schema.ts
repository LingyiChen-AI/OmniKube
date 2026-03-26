import { pgTable, uuid, varchar, text, boolean, timestamp, integer, jsonb, pgEnum, uniqueIndex, index } from 'drizzle-orm/pg-core';

// Enums
export const emailPurposeEnum = pgEnum('email_purpose', ['login', 'reset']);
export const clusterAuthTypeEnum = pgEnum('cluster_auth_type', ['kubeconfig', 'token']);
export const clusterStatusEnum = pgEnum('cluster_status', ['connected', 'disconnected', 'error']);
export const releaseStatusEnum = pgEnum('release_status', ['pending', 'applied', 'failed', 'rolled_back']);

// Users
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  username: varchar('username', { length: 255 }).notNull().unique(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  mustChangePassword: boolean('must_change_password').default(true).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  failedLoginAttempts: integer('failed_login_attempts').default(0).notNull(),
  lockedUntil: timestamp('locked_until'),
  lastLoginAt: timestamp('last_login_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Email verifications
export const emailVerifications = pgTable('email_verifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  code: varchar('code', { length: 6 }).notNull(),
  purpose: emailPurposeEnum('purpose').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  used: boolean('used').default(false).notNull(),
  attempts: integer('attempts').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('email_verifications_email_purpose_idx').on(table.email, table.purpose, table.used),
]);

// Sessions
export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: varchar('token', { length: 255 }).notNull().unique(),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: text('user_agent'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('sessions_expires_at_idx').on(table.expiresAt),
]);

// Clusters
export const clusters = pgTable('clusters', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull().unique(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  apiServerUrl: varchar('api_server_url', { length: 1024 }).notNull(),
  authType: clusterAuthTypeEnum('auth_type').notNull(),
  kubeconfig: text('kubeconfig'),
  saToken: text('sa_token'),
  caCert: text('ca_cert'),
  status: clusterStatusEnum('status').default('disconnected').notNull(),
  lastHealthCheckAt: timestamp('last_health_check_at'),
  description: text('description'),
  webhookUrl: text('webhook_url'),
  notifyEnabled: boolean('notify_enabled').default(false).notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Roles
export const roles = pgTable('roles', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull().unique(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  description: text('description'),
  isSystem: boolean('is_system').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Role permissions
export const rolePermissions = pgTable('role_permissions', {
  id: uuid('id').defaultRandom().primaryKey(),
  roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  resource: varchar('resource', { length: 255 }).notNull(),
  actions: text('actions').array().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('role_permissions_role_resource_idx').on(table.roleId, table.resource),
]);

// Role cluster bindings - defines which clusters a role can access
export const roleClusterBindings = pgTable('role_cluster_bindings', {
  id: uuid('id').defaultRandom().primaryKey(),
  roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  clusterId: uuid('cluster_id').references(() => clusters.id, { onDelete: 'cascade' }),
  namespaces: text('namespaces').array(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('role_cluster_bindings_role_cluster_idx').on(table.roleId, table.clusterId),
]);

// User role bindings - links users to roles (scope is defined at role level)
export const userRoleBindings = pgTable('user_role_bindings', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('user_role_bindings_unique_idx').on(table.userId, table.roleId),
]);

// App templates
export const appTemplates = pgTable('app_templates', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  version: integer('version').default(1).notNull(),
  description: text('description'),
  template: jsonb('template').notNull(),
  variables: jsonb('variables'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('app_templates_name_version_idx').on(table.name, table.version),
]);

// App releases
export const appReleases = pgTable('app_releases', {
  id: uuid('id').defaultRandom().primaryKey(),
  appTemplateId: uuid('app_template_id').references(() => appTemplates.id),
  clusterId: uuid('cluster_id').notNull().references(() => clusters.id),
  namespace: varchar('namespace', { length: 255 }),
  name: varchar('name', { length: 255 }).notNull(),
  values: jsonb('values'),
  renderedManifests: jsonb('rendered_manifests'),
  status: releaseStatusEnum('status').default('pending').notNull(),
  revision: integer('revision').default(1).notNull(),
  message: text('message'),
  releasedBy: uuid('released_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Audit logs
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id),
  action: varchar('action', { length: 50 }).notNull(),
  resourceType: varchar('resource_type', { length: 100 }).notNull(),
  resourceName: varchar('resource_name', { length: 255 }),
  clusterId: uuid('cluster_id').references(() => clusters.id),
  namespace: varchar('namespace', { length: 255 }),
  requestMethod: varchar('request_method', { length: 10 }),
  requestPath: varchar('request_path', { length: 1024 }),
  requestBody: jsonb('request_body'),
  responseStatus: integer('response_status'),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('audit_logs_created_at_idx').on(table.createdAt),
  index('audit_logs_user_id_idx').on(table.userId),
  index('audit_logs_resource_type_idx').on(table.resourceType),
]);
