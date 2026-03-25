export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startWsServer } = await import('@/lib/ws/server');
    startWsServer();
  }
}
