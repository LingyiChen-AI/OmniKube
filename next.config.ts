import type { NextConfig } from 'next';

// 子路径部署支持（如 nginx 反代到 /ops），构建时通过 NEXT_PUBLIC_BASE_PATH 指定
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

const nextConfig: NextConfig = {
  basePath,
  output: 'standalone',
  serverExternalPackages: ['ws', '@kubernetes/client-node'],
  allowedDevOrigins: ['54.186.80.96'],
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_SMTP_ENABLED: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) ? 'true' : '',
  },
};

export default nextConfig;
