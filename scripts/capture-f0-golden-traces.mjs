// F0 exit-gate evidence: runs one fixed, fully deterministic queue+repaint scenario
// twice - once with the performance observer absent, once wired - and proves the
// four behavioural traces (provider requests, dispatch order, commits, repaint
// batches) are byte-identical. Writes the traces and the verdict into
// artifacts/f0-realtime-metrics-20260825/.
import {createRequire} from "node:module";
import {createHash} from "node:crypto";
import {writeFileSync, mkdirSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {createLiveTranslationQueue} = require(path.join(rootDir, "src/orchestrator/live-translation-queue.js"));
const {createDisplayRepaintScheduler} = require(path.join(rootDir, "src/display/repaint-scheduler.js"));
const {createRealtimePerformanceTrace} = require(path.join(rootDir, "src/diagnostics/realtime-performance-trace.js"));

const settle = () => new Promise(resolve => setImmediate(resolve));

async function runScenario({withObserver}) {
	const log = {providerRequests: [], commits: [], repaintBatches: []};
	let clock = 1000;
	const schedulerTimers = [];
	const trace = withObserver ? createRealtimePerformanceTrace({now: () => clock}) : null;

	const scheduler = createDisplayRepaintScheduler({
		renderMessages: messageIds => {
			log.repaintBatches.push({at: clock, ids: messageIds.map(String)});
			return Promise.resolve({confirmedIds: messageIds.map(String)});
		},
		onRenderOutcome: report => {
			if (trace) trace.onRenderOutcome(report);
		},
		canRepaintNow: () => true,
		isViewingHistory: () => false,
		setTimeout: (callback, delay) => {
			schedulerTimers.push({callback, delay});
			return schedulerTimers.length;
		},
		clearTimeout: () => {}
	});

	const singleCompletions = [];
	const queue = createLiveTranslationQueue({
		now: () => clock,
		setTimeout: () => 0,
		clearTimeout: () => {},
		isTranslationEnabled: () => true,
		shouldAutoTranslateMessage: () => true,
		extractOriginalContentData: message => ({content: message.content || ""}),
		createTranslationSignature: (message, channelId, originalContentData) => `${channelId}|${originalContentData && originalContentData.content}`,
		getMessageChannelId: message => message.channelId || null,
		isProviderBackoffActive: () => false,
		getBatchEngineKey: () => "ai",
		createBurstContext: channelId => ({channelId, engineKey: "ai"}),
		prepareBurstItem: (queueItem, channelId) => ({
			queueItem,
			message: queueItem.message,
			signature: `${channelId}|${queueItem.message.content}`,
			protectedText: queueItem.message.content
		}),
		requestBurstTranslation: (context, prepared) => {
			log.providerRequests.push({at: clock, mode: "burst", ids: prepared.map(item => String(item.message.id)), texts: prepared.map(item => item.protectedText)});
			const resultMap = {};
			for (const item of prepared) resultMap[String(item.message.id)] = `T(${item.message.content})`;
			return Promise.resolve(resultMap);
		},
		resolveBurstItemResult: preparedItem => ({
			status: "translated",
			result: {sourceSignature: preparedItem.signature, status: "translated", translation: `T(${preparedItem.message.content})`}
		}),
		commitBurstResult: (queueItem, channelId, result) => {
			log.commits.push({at: clock, mode: "burst", messageId: String(queueItem.message.id), translation: result.translation});
			scheduler.schedule(channelId, String(queueItem.message.id));
			return Promise.resolve({confirmedIds: [String(queueItem.message.id)]});
		},
		commitCachedResult: (queueItem, channelId) => {
			log.commits.push({at: clock, mode: "cached", messageId: String(queueItem.message.id)});
			scheduler.schedule(channelId, String(queueItem.message.id));
			return Promise.resolve({confirmedIds: [String(queueItem.message.id)]});
		},
		translateSingleItem: queueItem => {
			log.providerRequests.push({at: clock, mode: "single", ids: [String(queueItem.message.id)], texts: [queueItem.message.content]});
			return new Promise(resolve => singleCompletions.push({
				finish: () => {
					log.commits.push({at: clock, mode: "single", messageId: String(queueItem.message.id), translation: `T(${queueItem.message.content})`});
					scheduler.schedule("c1", String(queueItem.message.id));
					resolve();
				}
			}));
		},
		observer: trace ? trace.queueObserver : null
	});

	async function drainSchedulerTimers() {
		while (schedulerTimers.length) {
			const timer = schedulerTimers.shift();
			clock += timer.delay;
			timer.callback();
			await settle();
		}
	}

	// Phase A - one live message goes down the single path.
	queue.queueMessage({id: "m1", content: "one"}, {id: "c1"});
	await settle();
	clock = 1500;
	singleCompletions.shift().finish();
	await settle();
	await drainSchedulerTimers();

	// Phase B - three messages accumulate behind the live lock and drain as one burst.
	queue.setLiveAutoTranslating(true);
	clock = 2000;
	queue.queueMessage({id: "m2", content: "two"}, {id: "c1"});
	clock = 2200;
	queue.queueMessage({id: "m3", content: "three"}, {id: "c1"});
	clock = 2500;
	queue.queueMessage({id: "m4", content: "four"}, {id: "c1"});
	queue.setLiveAutoTranslating(false);
	clock = 3000;
	queue.processQueue();
	await settle();
	await settle();
	await drainSchedulerTimers();

	// Phase C - a cached translation is served without a provider request.
	clock = 4000;
	queue.queueMessage({id: "m5", content: "five"}, {id: "c1"}, null, {cachedTranslation: {signature: "c1|five", translation: "T(five)"}});
	await settle();
	await drainSchedulerTimers();

	// Phase D - an edit between queueing and processing goes stale and never dispatches.
	queue.setLiveAutoTranslating(true);
	clock = 5000;
	const edited = {id: "m6", content: "original"};
	queue.queueMessage(edited, {id: "c1"});
	edited.content = "edited";
	queue.setLiveAutoTranslating(false);
	queue.processQueue();
	await settle();
	await drainSchedulerTimers();

	return {log, trace, scheduler};
}

const runWithout = await runScenario({withObserver: false});
const runWith = await runScenario({withObserver: true});

const serializedWithout = JSON.stringify(runWithout.log, null, 2);
const serializedWith = JSON.stringify(runWith.log, null, 2);
const hashWithout = createHash("sha256").update(serializedWithout).digest("hex");
const hashWith = createHash("sha256").update(serializedWith).digest("hex");
const equivalent = serializedWithout === serializedWith;

const outDir = path.join(rootDir, "artifacts", "f0-realtime-metrics-20260825");
mkdirSync(outDir, {recursive: true});
writeFileSync(path.join(outDir, "golden-trace-observer-off.json"), serializedWithout);
writeFileSync(path.join(outDir, "golden-trace-observer-on.json"), serializedWith);
writeFileSync(path.join(outDir, "observed-metrics-sample.json"), JSON.stringify({
	traceSnapshot: runWith.trace.getSnapshot(),
	schedulerDiagnostics: runWith.scheduler.getDiagnostics(),
	lifecycleTrace: runWith.trace.listTrace()
}, null, 2));
writeFileSync(path.join(outDir, "golden-trace-equivalence.txt"), [
	`captured_from=perf/realtime-f0-metrics (parent 6b4a9bf + F0 working tree)`,
	`sha256_observer_off=${hashWithout}`,
	`sha256_observer_on=${hashWith}`,
	`verdict=${equivalent ? "EQUIVALENT" : "DIVERGENT"}`,
	`provider_requests=${runWith.log.providerRequests.length}`,
	`commits=${runWith.log.commits.length}`,
	`repaint_batches=${runWith.log.repaintBatches.length}`,
	""
].join("\n"));

console.log(`observer-off sha256: ${hashWithout}`);
console.log(`observer-on  sha256: ${hashWith}`);
console.log(`verdict: ${equivalent ? "EQUIVALENT" : "DIVERGENT"}`);
if (!equivalent) process.exit(1);
