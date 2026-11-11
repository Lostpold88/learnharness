import { spawn } from "node:child_process";
import { getAgyBinary } from "./binary.ts";
import { inspectAgyInstallation, readAgyVersion, type ReadAgyVersion } from "./installation.ts";
import type { RunAgy } from "./stream.ts";

export class AgyLaunchError extends Error {}

/** Injectable seams keep all verification offline; production uses the installed CLI. */
export function createAgyLauncher({
	findBinary = getAgyBinary,
	readVersion = readAgyVersion,
	spawnProcess = spawn,
}: {
	findBinary?: () => string | null;
	readVersion?: ReadAgyVersion;
	spawnProcess?: typeof spawn;
} = {}): RunAgy {
	return async (args, options) => {
		if (options.signal?.aborted) throw new AgyLaunchError("Request was aborted");
		const binary = findBinary();
		if (!binary) return null;
		const status = await inspectAgyInstallation(() => binary, readVersion);
		if (status.state === "update-required") {
			throw new AgyLaunchError(`Antigravity ${status.version} requires an update. LearnHarness requires at least ${status.minimumVersion}; update agy outside LearnHarness.`);
		}
		if (status.state !== "meets-minimum") {
			throw new AgyLaunchError("Antigravity's version could not be checked. Check your installation outside LearnHarness and try again.");
		}
		if (options.signal?.aborted) throw new AgyLaunchError("Request was aborted");
		return spawnProcess(binary, args, { cwd: options.cwd, env: options.env, stdio: "pipe" });
	};
}
