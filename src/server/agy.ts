import { inspectAgyInstallation } from "../agent/agy/installation.ts";
import { initAuthEnv } from "./keys.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";
import { agyEnabled } from "./agy-config.ts";

/** The Settings status seam: initialize provenance before any child env is copied. */
export async function agyInstallationStatus() {
	initAuthEnv();
	return inspectAgyInstallation();
}

/** Same-origin browser intent, not user authentication. No CORS grants.
 * A public/shared server still requires its own access-control boundary. */
export async function agyInstallationResponse(
	request: Request,
	inspect = agyInstallationStatus,
	enabled = agyEnabled,
): Promise<Response> {
	const origin = subscriptionRequestOrigin(request);
	const supplied = request.headers.get("origin");
	const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
	if (request.method !== "GET" || !origin
		|| request.headers.get("x-learnharness-agy") !== "1"
		|| request.headers.get("sec-fetch-site") === "cross-site"
		|| (supplied !== null && supplied !== origin)) {
		return Response.json({ error: "Antigravity checks require a same-origin LearnHarness request." }, { status: 403, headers });
	}
	if (!enabled()) return Response.json({ error: "Antigravity is disabled." }, { status: 403, headers });
	return Response.json(await inspect(), { headers });
}
