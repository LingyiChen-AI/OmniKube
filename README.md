# K8s Admin

Multi-cluster Kubernetes management platform with RBAC, application deployment, and real-time monitoring.

## Features

- **Multi-Cluster Management** - Connect and manage multiple Kubernetes clusters via Token or Kubeconfig
- **RBAC** - Role-based access control with cluster and namespace level permissions
- **Resource Management** - View and edit Deployments, StatefulSets, DaemonSets, Services, Ingresses, ConfigMaps, Secrets, PVCs, etc.
- **Application Deployment** - Template-based app deployment with revision tracking and rollback
- **Real-time Terminal** - WebSocket-based Pod exec terminal
- **Dashboard** - Cluster status, Pod/Deployment counts, recent events, filtered by user permissions
- **Audit Logging** - Track all user operations
- **Notifications** - Feishu webhook notifications on deploy/rollback

## Tech Stack

- **Frontend**: Next.js 16, React 19, Ant Design 5, Zustand
- **Backend**: Next.js API Routes, Custom Server (WebSocket), Drizzle ORM
- **Database**: PostgreSQL
- **Auth**: JWT
- **K8s**: @kubernetes/client-node

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL

### Development

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your DATABASE_URL and other settings

# Start dev server
npm run dev
```

Open http://localhost:3000. On first startup, the database is auto-created, migrated, and seeded with an admin account (check console output for credentials).

### Docker

```bash
# Build
docker build -t twwch/k8s-admin .

# Run
./docker_run.sh
```

The `docker_run.sh` script mounts `~/.aws` (read-only) and `.env` into the container.

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | required |
| `ENCRYPTION_KEY` | 32-byte hex key for encrypting cluster credentials | required |
| `SESSION_EXPIRY_HOURS` | JWT session expiry | `24` |
| `SMTP_HOST` | SMTP server for email verification | - |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_USER` | SMTP username | - |
| `SMTP_PASS` | SMTP password | - |
| `SMTP_FROM` | Sender email address | `noreply@k8sadmin.local` |

## Auto-Initialization

On startup, the server automatically:

1. **Creates the database** if it doesn't exist
2. **Runs migrations** from `drizzle/` (skips if tables already exist)
3. **Seeds initial data** - built-in roles (super-admin, cluster-admin, developer, viewer) and an admin user with a random password printed to console

## CI/CD

GitHub Actions workflow (`.github/workflows/docker-publish.yml`):

- Push to `main` - builds and pushes `twwch/k8s-admin:latest`
- Push `v*` tag - builds versioned image and creates GitHub Release

## License

Licensed under the [Apache License 2.0](LICENSE).
