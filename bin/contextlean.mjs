#!/usr/bin/env node

import { main } from "../plugins/contextlean/skills/optimize-agent-context/scripts/contextlean.mjs";

await main(process.argv.slice(2));
