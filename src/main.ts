import './infrastructure/config'; // fail-fast env validation runs on import
import { createApp } from './infrastructure/http/app';
import { config } from './infrastructure/config';

const app = createApp();

app.listen(config.port, () => {
  console.log(`[server] Running on port ${config.port}`);
});
