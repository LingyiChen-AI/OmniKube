import 'dotenv/config';
import { startWsServer } from './lib/ws/server';

// Standalone mode: start WS server on its own port
startWsServer();
