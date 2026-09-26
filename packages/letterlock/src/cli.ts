#!/usr/bin/env node
import { run } from "./cli/program.ts";

const readStdin = async (): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  return new Uint8Array(Buffer.concat(chunks));
};

process.exitCode = await run(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, readStdin, env: process.env });
