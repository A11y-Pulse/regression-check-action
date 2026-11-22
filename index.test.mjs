import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { run } from "./index.mjs";

function jsonResponse(status, body) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function check(overrides) {
	return {
		id: "chk_1",
		status: "complete",
		conclusion: "success",
		summary: { added: 0, fixed: 0, unchanged: 0, needsReview: 0 },
		issues: [],
		newPages: [],
		skipped: [],
		reportUrl: "https://app.example.com/regression-checks/chk_1",
		...overrides,
	};
}

function fakeFetch(getResponses) {
	const calls = [];
	const queue = [...getResponses];
	const impl = async (url, init) => {
		calls.push({ url, init });

		if (init?.method === "POST") {
			return jsonResponse(202, {
				data: check({ status: "waiting_for_preview", conclusion: null }),
			});
		}

		return (queue.length > 1 ? queue.shift() : queue[0]).clone();
	};

	return { impl, calls };
}

function captureConsole(method) {
	const lines = [];
	const original = console[method];
	console[method] = (...args) => lines.push(args.join(" "));

	return {
		lines,
		restore: () => {
			console[method] = original;
		},
	};
}

describe("regression check action", () => {
	let dir;
	let summaryPath;
	let env;
	const noSleep = async () => {};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "regression-action-"));
		summaryPath = join(dir, "summary.md");
		writeFileSync(summaryPath, "");
		env = {
			"INPUT_API-KEY": "secret-key",
			"INPUT_SITE-ID": "site_1",
			"INPUT_HEAD-URL": "https://head.example.com",
			"INPUT_BASE-URL": "https://base.example.com",
			"INPUT_API-URL": "https://api.example.com",
			"INPUT_FAIL-ON": "serious",
			"INPUT_TIMEOUT-MINUTES": "10",
			"INPUT_BASE-REF": "abc123",
			INPUT_PATHS: "/\n/pricing\n",
			GITHUB_STEP_SUMMARY: summaryPath,
		};
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("exits 1 on failure conclusion and writes the summary", async () => {
		const { impl } = fakeFetch([
			jsonResponse(200, {
				data: check({
					conclusion: "failure",
					summary: { added: 1, fixed: 0, unchanged: 2, needsReview: 0 },
					issues: [
						{
							auditId: "color-contrast",
							title: "Elements must have sufficient colour contrast",
							impact: "serious",
							where: "Header",
							pages: ["/", "/pricing"],
							count: 3,
						},
					],
				}),
			}),
		]);

		const code = await run(env, impl, noSleep);
		const summary = readFileSync(summaryPath, "utf8");

		assert.equal(code, 1);
		assert.match(summary, /\| Where \| Pages \|/);
		assert.match(summary, /\| Header \| 2 \|/);
		assert.match(summary, /chk_1/);
	});

	it("exits 0 on success", async () => {
		const { impl } = fakeFetch([jsonResponse(200, { data: check() })]);

		assert.equal(await run(env, impl, noSleep), 0);
	});

	it("polls until a terminal status", async () => {
		const { impl, calls } = fakeFetch([
			jsonResponse(200, {
				data: check({ status: "scanning", conclusion: null }),
			}),
			jsonResponse(200, { data: check() }),
		]);

		assert.equal(await run(env, impl, noSleep), 0);
		assert.equal(
			calls.filter((call) => call.init?.method !== "POST").length,
			2,
		);
	});

	it("exits 1 after timeout-minutes by wall clock", async () => {
		const { impl } = fakeFetch([
			jsonResponse(200, {
				data: check({ status: "scanning", conclusion: null }),
			}),
		]);
		let time = 0;
		const sleep = async (ms) => {
			time += ms;
		};
		env["INPUT_TIMEOUT-MINUTES"] = "1";

		assert.equal(await run(env, impl, sleep, () => time), 1);
		assert.equal(time, 60_000);
	});

	for (const value of ["", "abc", "0", "-5"]) {
		it(`exits 1 before calling the API when timeout-minutes is "${value}"`, async () => {
			const errors = captureConsole("error");
			const { impl, calls } = fakeFetch([jsonResponse(200, { data: check() })]);
			env["INPUT_TIMEOUT-MINUTES"] = value;

			try {
				assert.equal(await run(env, impl, noSleep), 1);
				assert.equal(calls.length, 0);
				assert.match(errors.lines.join("\n"), /timeout-minutes/);
			} finally {
				errors.restore();
			}
		});
	}

	it("escapes page-derived text in the summary table", async () => {
		const { impl } = fakeFetch([
			jsonResponse(200, {
				data: check({
					conclusion: "failure",
					issues: [
						{
							auditId: "x",
							title: "Title `code`",
							impact: "serious",
							where: "a | b\nc <img src=x>",
							pages: ["/"],
							count: 1,
						},
					],
				}),
			}),
		]);

		await run(env, impl, noSleep);

		const rows = readFileSync(summaryPath, "utf8")
			.split("\n")
			.filter((line) => line.startsWith("| Title"));

		assert.equal(rows.length, 1);
		assert.match(rows[0], /a \\\| b c &lt;img src=x&gt;/);
		assert.match(rows[0], /Title &#96;code&#96;/);
	});

	it("retries after a 502", async () => {
		const warnings = captureConsole("warn");

		try {
			const { impl } = fakeFetch([
				jsonResponse(502, { title: "Bad Gateway" }),
				jsonResponse(200, { data: check() }),
			]);

			assert.equal(await run(env, impl, noSleep), 0);
		} finally {
			warnings.restore();
		}
	});

	it("retries after a thrown fetch while polling", async () => {
		const warnings = captureConsole("warn");
		let gets = 0;

		try {
			const impl = async (_url, init) => {
				if (init?.method === "POST") {
					return jsonResponse(202, { data: check({ status: "scanning" }) });
				}

				gets += 1;

				if (gets === 1) {
					throw new TypeError("fetch failed");
				}

				return jsonResponse(200, { data: check() });
			};

			assert.equal(await run(env, impl, noSleep), 0);
			assert.equal(gets, 2);
		} finally {
			warnings.restore();
		}
	});

	it("exits 1 when the POST throws", async () => {
		const errors = captureConsole("error");

		try {
			const impl = async () => {
				throw new TypeError("fetch failed");
			};

			assert.equal(await run(env, impl, noSleep), 1);
		} finally {
			errors.restore();
		}
	});

	it("passes an abort signal on every request", async () => {
		const { impl, calls } = fakeFetch([jsonResponse(200, { data: check() })]);

		await run(env, impl, noSleep);

		for (const call of calls) {
			assert.ok(call.init.signal instanceof AbortSignal);
		}
	});

	it("escapes workflow commands in the notice", async () => {
		const logs = captureConsole("log");

		try {
			const { impl } = fakeFetch([
				jsonResponse(200, {
					data: check({
						status: "cancelled",
						conclusion: "neutral",
						reportUrl: "https://x.test/r\n::set-output name=a::b%",
					}),
				}),
			]);

			await run(env, impl, noSleep);

			assert.equal(logs.lines.length, 1);
			assert.ok(logs.lines[0].includes("%0A::set-output"));
			assert.ok(logs.lines[0].endsWith("b%25"));
			assert.ok(!logs.lines[0].includes("\n"));
		} finally {
			logs.restore();
		}
	});

	it("sends the API key as a bearer token and the request body", async () => {
		const { impl, calls } = fakeFetch([jsonResponse(200, { data: check() })]);

		await run(env, impl, noSleep);

		const post = calls[0];
		assert.equal(
			post.url,
			"https://api.example.com/v1/sites/site_1/regression-checks",
		);
		assert.equal(post.init.headers.Authorization, "Bearer secret-key");
		assert.deepEqual(JSON.parse(post.init.body), {
			headUrl: "https://head.example.com",
			baseUrl: "https://base.example.com",
			paths: ["/", "/pricing"],
			baseRef: "abc123",
			failOn: "serious",
		});
		assert.equal(
			calls[1].url,
			"https://api.example.com/v1/regression-checks/chk_1",
		);
		assert.equal(calls[1].init.headers.Authorization, "Bearer secret-key");
	});

	it("exits 1 and prints the error title on a non-2xx POST without leaking the key", async () => {
		const errors = captureConsole("error");

		try {
			const impl = async () =>
				jsonResponse(403, {
					title: "Regression checks are not enabled for this team",
				});
			const code = await run(env, impl, noSleep);

			assert.equal(code, 1);
			assert.match(errors.lines.join("\n"), /not enabled for this team/);
			assert.doesNotMatch(errors.lines.join("\n"), /secret-key/);
		} finally {
			errors.restore();
		}
	});

	it("exits 1 on a GET 4xx", async () => {
		const errors = captureConsole("error");

		try {
			const { impl } = fakeFetch([jsonResponse(404, { title: "Not Found" })]);

			assert.equal(await run(env, impl, noSleep), 1);
		} finally {
			errors.restore();
		}
	});

	it("exits 1 when the check errors", async () => {
		const { impl } = fakeFetch([
			jsonResponse(200, { data: check({ status: "error", conclusion: null }) }),
		]);

		assert.equal(await run(env, impl, noSleep), 1);
	});

	for (const status of ["cancelled", "timed_out"]) {
		it(`exits 0 with a notice when ${status}`, async () => {
			const logs = captureConsole("log");

			try {
				const { impl } = fakeFetch([
					jsonResponse(200, { data: check({ status, conclusion: "neutral" }) }),
				]);

				assert.equal(await run(env, impl, noSleep), 0);
				assert.match(logs.lines.join("\n"), /::notice::/);
			} finally {
				logs.restore();
			}
		});
	}
});
