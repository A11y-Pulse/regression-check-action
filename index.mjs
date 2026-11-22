import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const POLL_INTERVAL_MS = 10_000;
const MINUTE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const TERMINAL_STATUSES = new Set([
	"complete",
	"error",
	"cancelled",
	"timed_out",
]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function input(env, name) {
	return (env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
}

async function errorTitle(response) {
	try {
		const body = await response.json();

		return body.title ?? `HTTP ${response.status}`;
	} catch {
		return `HTTP ${response.status}`;
	}
}

function escapeCell(value) {
	return String(value)
		.replace(/[\r\n]+/g, " ")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/`/g, "&#96;")
		.replace(/\|/g, "\\|");
}

function escapeCommand(value) {
	return String(value)
		.replace(/%/g, "%25")
		.replace(/\r/g, "%0D")
		.replace(/\n/g, "%0A");
}

function summaryMarkdown(check) {
	const { added, fixed, unchanged, needsReview } = check.summary;
	const lines = [
		"## A11y Pulse regression check",
		"",
		`${added} added, ${fixed} fixed, ${unchanged} unchanged, ${needsReview} needs review. Checks against automated rules only.`,
		"",
	];

	if (check.issues.length > 0) {
		lines.push(
			"| Issue | Impact | Where | Pages | Count |",
			"| --- | --- | --- | --- | --- |",
		);

		for (const issue of check.issues) {
			lines.push(
				`| ${escapeCell(issue.title)} | ${escapeCell(issue.impact ?? "n/a")} | ${escapeCell(issue.where)} | ${issue.pages.length} | ${issue.count} |`,
			);
		}

		lines.push("");
	}

	lines.push(`[View the full report](${check.reportUrl}) (${check.id})`, "");

	return lines.join("\n");
}

function writeOutputs(env, check) {
	if (env.GITHUB_STEP_SUMMARY) {
		appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown(check));
	}

	if (env.GITHUB_OUTPUT) {
		appendFileSync(
			env.GITHUB_OUTPUT,
			`conclusion=${check.conclusion ?? ""}\nreport-url=${check.reportUrl}\n`,
		);
	}
}

/**
 * Starts a regression check, polls it to a terminal status, and returns the
 * process exit code.
 */
export async function run(
	env,
	fetchImpl = fetch,
	sleep = defaultSleep,
	now = Date.now,
) {
	const timeoutMinutes = Number(input(env, "timeout-minutes"));

	if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
		console.error(
			`timeout-minutes must be a positive number, got "${input(env, "timeout-minutes")}".`,
		);

		return 1;
	}

	const apiKey = input(env, "api-key");
	const apiUrl = input(env, "api-url").replace(/\/+$/, "");
	const headers = {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
	};
	const paths = input(env, "paths")
		.split("\n")
		.map((path) => path.trim())
		.filter(Boolean);
	const baseRef = input(env, "base-ref");
	const body = {
		headUrl: input(env, "head-url"),
		baseUrl: input(env, "base-url"),
		...(paths.length > 0 && { paths }),
		...(baseRef && { baseRef }),
		failOn: input(env, "fail-on"),
	};

	let created;

	try {
		created = await fetchImpl(
			`${apiUrl}/v1/sites/${input(env, "site-id")}/regression-checks`,
			{
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			},
		);
	} catch (error) {
		console.error(`Could not start the regression check: ${error.message}`);

		return 1;
	}

	if (!created.ok) {
		console.error(
			`Could not start the regression check: ${await errorTitle(created)}`,
		);

		return 1;
	}

	const { id } = (await created.json()).data;
	const deadline = now() + timeoutMinutes * MINUTE_MS;

	while (true) {
		let response;

		try {
			response = await fetchImpl(`${apiUrl}/v1/regression-checks/${id}`, {
				headers,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			console.warn(`Polling failed, retrying: ${error.message}`);
		}

		if (response && response.status >= 400 && response.status < 500) {
			console.error(
				`Could not read the regression check: ${await errorTitle(response)}`,
			);

			return 1;
		}

		if (response?.ok) {
			const check = (await response.json()).data;

			if (TERMINAL_STATUSES.has(check.status)) {
				writeOutputs(env, check);

				if (check.status === "error") {
					console.error("The regression check ended with an error.");

					return 1;
				}

				if (check.status !== "complete") {
					console.log(
						`::notice::The regression check ended as ${check.status}. See ${escapeCommand(check.reportUrl)}`,
					);

					return 0;
				}

				return check.conclusion === "failure" ? 1 : 0;
			}
		}

		if (now() >= deadline) {
			console.error(
				`The regression check did not finish within ${timeoutMinutes} minutes.`,
			);

			return 1;
		}

		await sleep(POLL_INTERVAL_MS);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	process.exitCode = await run(process.env);
}
