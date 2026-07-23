import { createLocalHost, assertLoopbackHost } from "./host.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const host = argument("--host") ?? "127.0.0.1";
const portValue = argument("--port") ?? "4174";
const port = Number(portValue);

assertLoopbackHost(host);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid port: ${portValue}`);
}

createLocalHost().listen(port, host, () => {
  console.log(`Aldunis Code is available at http://${host}:${port}`);
});
