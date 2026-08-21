import { config } from "./config.ts";
import { migrate } from "./db/db.ts";
import { seed } from "./db/seed.ts";
import { startExpirySweep } from "./modules/sessions/service.ts";
import { createApp } from "./app.ts";

migrate();
seed();
startExpirySweep();

createApp().listen(config.port, () => {
  console.log(`api + web on http://localhost:${config.port}`);
});
