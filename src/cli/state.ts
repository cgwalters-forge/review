import { runState } from "./statecommand.ts";

process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

process.exitCode = await runState(process.argv.slice(2), process.env, (s) => { process.stdout.write(s); }, (s) => { process.stderr.write(s); });
