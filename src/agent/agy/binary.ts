import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type BinaryLookup = {
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
	homeDir: string;
	cwd?: string;
	isExecutable: (path: string) => boolean;
};

export function resolveAgyBinary({ env, platform, homeDir, cwd = process.cwd(), isExecutable }: BinaryLookup): string | null {
	const paths = platform === "win32" ? path.win32 : path.posix;
	// Direct spawn deliberately uses no shell: only a real executable counts as available.
	const name = platform === "win32" ? "agy.exe" : "agy";
	const knownDirs = platform === "win32"
		? [paths.join(homeDir, ".local", "bin")]
		: [paths.join(homeDir, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
	const pathDirs = (env.PATH ?? "").split(paths.delimiter).filter(Boolean);

	for (const dir of [...pathDirs, ...knownDirs]) {
		// Discovery is relative to the server cwd; probes/model work use
		// different directories and must receive the same absolute identity.
		const candidate = paths.resolve(cwd, dir, name);
		if (isExecutable(candidate)) return candidate;
	}

	return null;
}

function isExecutableFile(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

export function getAgyBinary(): string | null {
	return resolveAgyBinary({
		env: process.env,
		platform: process.platform,
		homeDir: os.homedir(),
		isExecutable: isExecutableFile,
	});
}
