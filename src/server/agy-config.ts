import { getAgyBinary } from "../agent/agy/binary.ts";
import { settingsStore } from "../store/settings.ts";

/** Fresh admission state, not a process-wide cache. Existing runs retain
 * their engines; only new chat/job/extraction/compaction admissions consult it. */
export function agyEnabled(): boolean {
	return settingsStore.readSettings()?.agy?.enabled === true;
}

/** Installation/opt-in availability only, never authenticated readiness. */
export function agyAvailable(): boolean {
	return agyEnabled() && getAgyBinary() !== null;
}
