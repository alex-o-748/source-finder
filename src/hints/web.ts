#!/usr/bin/env node
/** Starts the hints API. Toolforge's Build Service sets PORT. */

import { createHintServer } from "./server.js";
import { defaultHintsDir, fileStore } from "./store.js";

const port = Number(process.env.PORT || 8000);
const dir = defaultHintsDir();
createHintServer(fileStore(dir)).listen(port, () => {
  console.log(`CNfirmed hints on :${port}, reading ${dir}`);
});
