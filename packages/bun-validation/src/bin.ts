#!/usr/bin/env bun
// Ref: https://bun.com/docs/runtime/utils#import-meta
import { runCli } from "./cli.ts";

process.exit(await runCli(process.argv.slice(2)));
