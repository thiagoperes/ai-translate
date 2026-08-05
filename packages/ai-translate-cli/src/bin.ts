#!/usr/bin/env node

import { runCli } from "./index";

const exitCode = await runCli();
process.exit(exitCode);
