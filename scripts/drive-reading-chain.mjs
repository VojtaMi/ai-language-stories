/**
 * Reads a chain of reading stories end to end in a real browser, as one
 * simulated learner: every part with its narration and images, the recap, and
 * the difficulty rating that steers the next story. Unlike `story:chain`, this
 * exercises the real app, including TTS, images, and the finish handoff.
 *
 *   node scripts/drive-reading-chain.mjs --base http://localhost:5174 \
 *     --language german --feedback tooEasy,tooEasy,tooHard,right \
 *     --out .artifacts/experiment/run-a
 *
 * `--feedback` sets the chain length; each entry is a StoryDifficulty. Recap
 * exercises are answered right first time, except after a story rated hard,
 * where the learner first picks one wrong choice per exercise. The browser
 * profile in `<out>/profile` is the learner: reuse `--out` to continue a chain.
 *
 * Writes `<out>/chain.json` (story ids, parts, ratings) and a screenshot per
 * part. The story's own `generation.json` beside its media holds the
 * intermediate generation results.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const base = readArg("--base") ?? "http://localhost:5174";
const language = readArg("--language") ?? "german";
const feedback = (readArg("--feedback") ?? "right").split(",");
const out = resolve(readArg("--out") ?? ".artifacts/reading-chain");
const STORY_TIMEOUT_MS = 15 * 60_000;

await mkdir(out, { recursive: true });
const chainPath = join(out, "chain.json");
const chain = await readFile(chainPath, "utf8")
	.then(JSON.parse)
	.catch(() => ({ stories: [] }));

const context = await chromium.launchPersistentContext(join(out, "profile"), {
	viewport: { width: 1400, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
// Playwright actions otherwise wait forever, which hides a stalled story.
page.setDefaultTimeout(10 * 60_000);
page.on("console", (message) => {
	if (message.type() === "error") log(`console error: ${message.text()}`);
});

try {
	for (let index = chain.stories.length; index < feedback.length; index += 1) {
		const story = await readStory(index + 1, feedback[index]);
		chain.stories.push(story);
		await writeFile(chainPath, `${JSON.stringify(chain, null, 2)}\n`);
	}
} finally {
	await context.close();
}

async function readStory(number, difficulty) {
	log(`story ${number}: waiting for it to be prepared`);
	await page.goto(`${base}/${language}`, { waitUntil: "domcontentloaded" });
	const start = page.getByRole("button", { name: "Reading Story" });
	await start.waitFor({ timeout: STORY_TIMEOUT_MS });
	const startedAt = Date.now();
	await start.click();
	await page.waitForURL(/\/story\//);
	const storyId = page.url().split("/story/")[1];
	log(`story ${number}: ${storyId}`);

	const parts = [];
	for (;;) {
		const progress = await page
			.getByText(/^Part \d+ of \d+$/)
			.first()
			.innerText();
		const [, current, total] = progress.match(/Part (\d+) of (\d+)/);
		await waitForPartImage(storyId, Number(current), Number(total));
		const shot = join(out, `story-${number}-part-${current}.png`);
		await page.screenshot({ path: shot });
		parts.push({ part: Number(current), shot, text: await currentPartText() });
		const button = page.getByRole("button", {
			name: current === total ? "Finish story" : "Next part",
		});
		await button.click();
		if (current === total) break;
		await page.getByText(`Part ${Number(current) + 1} of ${total}`).waitFor();
	}

	const recap = await solveRecap(
		difficulty === "tooHard" || difficulty === "bitHard",
	);
	await page.getByRole("button", { name: labelFor(difficulty) }).click();
	await page.getByRole("button", { name: "Submit feedback" }).click();
	await page.getByText("Thanks — noted for next time.").waitFor();
	await page.screenshot({ path: join(out, `story-${number}-finish.png`) });
	await waitForFile(
		join("stories", language, storyId, "finish-evidence.json"),
		5 * 60_000,
	);
	log(`story ${number}: finished as ${difficulty}`);
	return {
		number,
		storyId,
		difficulty,
		readingMs: Date.now() - startedAt,
		parts,
		recap,
	};
}

/** Parts that start a new image wait until it exists, so the shot shows it. */
async function waitForPartImage(storyId, part, total) {
	const imageParts = [];
	for (let p = 1; p <= total; p += 2) imageParts.push(p);
	if (imageParts.at(-1) !== total) imageParts.push(total);
	if (!imageParts.includes(part)) return;
	const url = `${base}/api/story-images/${storyId}/section_${part}.webp`;
	const deadline = Date.now() + 5 * 60_000;
	while (Date.now() < deadline) {
		const response = await page.request.get(url);
		if (response.ok()) {
			await page.waitForFunction(
				(name) =>
					[...document.querySelectorAll("*")].some((element) =>
						getComputedStyle(element).backgroundImage.includes(name),
					),
				`section_${part}.webp`,
				{ timeout: 60_000 },
			);
			await page.waitForTimeout(1500);
			return;
		}
		await page.waitForTimeout(3000);
	}
	log(`image for part ${part} never appeared`);
}

async function currentPartText() {
	return page.evaluate(() => {
		const progress = [...document.querySelectorAll("*")].find(
			(element) =>
				element.children.length === 0 &&
				/^Part \d+ of \d+$/.test(element.textContent?.trim() ?? ""),
		);
		const card = progress?.parentElement;
		return card?.innerText.replace(/^Part \d+ of \d+\s*/, "").split("\n⏸")[0];
	});
}

/**
 * Answers each recap exercise from the props React rendered it with, so the
 * simulated learner is consistent rather than lucky.
 */
async function solveRecap(withMistakes) {
	await page
		.locator(".story-recap__exercise")
		.first()
		.waitFor({ timeout: 5 * 60_000 });
	const exercises = await page.evaluate(() => {
		const propsOf = (element) => {
			const key = Object.keys(element).find((name) =>
				name.startsWith("__reactFiber$"),
			);
			for (let fiber = element[key]; fiber; fiber = fiber.return) {
				const props = fiber.memoizedProps;
				if (props && ("answer" in props || props.exercise?.pairs)) return props;
			}
			return null;
		};
		return [...document.querySelectorAll(".story-recap__exercise")].map(
			(section) => {
				const props = propsOf(section.querySelector("button"));
				return {
					title: section.querySelector("h3")?.textContent,
					prompt: section.querySelector(".story-recap__prompt")?.textContent,
					answer: props?.answer,
					choices: props?.choices,
					pairs: props?.exercise?.pairs,
				};
			},
		);
	});
	const sections = page.locator(".story-recap__exercise");
	for (const [index, exercise] of exercises.entries()) {
		const section = sections.nth(index);
		if (exercise.pairs) {
			for (const pair of exercise.pairs) {
				await section
					.getByRole("button", { name: pair.term, exact: true })
					.click();
				await section
					.getByRole("button", { name: pair.meaning, exact: true })
					.click();
			}
			continue;
		}
		if (withMistakes) {
			const wrong = exercise.choices.find(
				(choice) => choice !== exercise.answer,
			);
			await section.getByRole("button", { name: wrong, exact: true }).click();
			await page.waitForTimeout(800);
		}
		await section
			.getByRole("button", { name: exercise.answer, exact: true })
			.click();
	}
	await page.screenshot({
		path: join(out, "recap-latest.png"),
		fullPage: true,
	});
	await page.getByRole("button", { name: "Continue" }).click();
	return exercises;
}

function labelFor(difficulty) {
	return {
		tooEasy: "Too easy",
		bitEasy: "A bit easy",
		right: "Just right",
		bitHard: "A bit hard",
		tooHard: "Too hard",
	}[difficulty];
}

async function waitForFile(path, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await access(path);
			return;
		} catch {
			await page.waitForTimeout(2000);
		}
	}
	log(`${path} never appeared`);
}

function log(message) {
	console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function readArg(name) {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}
