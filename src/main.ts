import { loadConfig } from './config';
import { createGateway } from './server';

const config = loadConfig();
const server = createGateway(config);

if (config.apiKeys.length === 0) {
  console.warn(JSON.stringify({ level: 'warn', msg: 'GATEWAY_API_KEYS is empty: the gateway accepts anyone' }));
}

server.listen(config.port, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'listening',
      port: config.port,
      relayUrl: config.relayUrl,
      channels: config.allowedChannels,
    }),
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
