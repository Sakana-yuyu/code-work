/**
 * Short-lived local TCP port forward (ssh -L data-plane equivalent).
 * Usage: node tcp-forward-tunnel.mjs <listenHost> <listenPort> <targetHost> <targetPort>
 * Writes pid to stdout once; forwards until SIGTERM/SIGINT.
 */
import * as NodeNet from "node:net";

const [listenHost, listenPortRaw, targetHost, targetPortRaw] = process.argv.slice(2);
const listenPort = Number(listenPortRaw);
const targetPort = Number(targetPortRaw);
if (!listenHost || !Number.isFinite(listenPort) || !targetHost || !Number.isFinite(targetPort)) {
  console.error(
    "usage: tcp-forward-tunnel.mjs <listenHost> <listenPort> <targetHost> <targetPort>",
  );
  process.exit(2);
}

const server = NodeNet.createServer((inbound) => {
  const outbound = NodeNet.connect({ host: targetHost, port: targetPort }, () => {
    inbound.pipe(outbound);
    outbound.pipe(inbound);
  });
  const closeBoth = () => {
    inbound.destroy();
    outbound.destroy();
  };
  inbound.on("error", closeBoth);
  outbound.on("error", closeBoth);
  inbound.on("close", () => outbound.destroy());
  outbound.on("close", () => inbound.destroy());
});

server.on("error", (error) => {
  console.error(String(error));
  process.exit(1);
});

server.listen(listenPort, listenHost, () => {
  process.stdout.write(
    JSON.stringify({
      ok: true,
      pid: process.pid,
      listen: `${listenHost}:${listenPort}`,
      target: `${targetHost}:${targetPort}`,
    }) + "\n",
  );
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
