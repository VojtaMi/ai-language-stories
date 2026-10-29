import type { LanguageId } from "../languages";
import type { SavedStory, SavedStorySummary } from "../saves";
import { isSupportedReadingStory } from "../story";

const DATABASE_NAME = "language-story-reader";
const DATABASE_VERSION = 1;
const STORIES_STORE = "stories";

export interface StoryStore {
	list(languageId?: LanguageId): Promise<SavedStorySummary[]>;
	get(storyId: string): Promise<SavedStory | null>;
	save(story: SavedStory): Promise<SavedStory>;
	patch(
		storyId: string,
		changes: Partial<SavedStory>,
	): Promise<SavedStory | null>;
	delete(storyId: string): Promise<void>;
}

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
	if (databasePromise) return databasePromise;
	if (typeof indexedDB === "undefined") {
		return Promise.reject(
			new Error("This browser does not support IndexedDB."),
		);
	}

	databasePromise = new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
		request.onupgradeneeded = () => {
			request.result.createObjectStore(STORIES_STORE, { keyPath: "id" });
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("Could not open story storage."));
	});

	return databasePromise;
}

async function withStore<T>(
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
	const database = await openDatabase();
	const transaction = database.transaction(STORIES_STORE, mode);
	return new Promise((resolve, reject) => {
		let result: T;
		const request = operation(transaction.objectStore(STORIES_STORE));
		request.onsuccess = () => {
			result = request.result;
		};
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed."));
		transaction.oncomplete = () => resolve(result);
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed."));
		transaction.onabort = () =>
			reject(
				transaction.error ?? new Error("IndexedDB transaction was aborted."),
			);
	});
}

function summary(story: SavedStory): SavedStorySummary {
	const latestText =
		story.currentTarget ??
		story.segments[story.segments.length - 1]?.text ??
		story.messages[story.messages.length - 1]?.content ??
		"";
	return {
		id: story.id,
		genreId: story.genreId,
		title: story.title,
		createdAt: story.createdAt ?? story.updatedAt,
		updatedAt: story.updatedAt,
		preview: latestText.slice(0, 180),
		phase: story.phase,
		isReadingStory: Boolean(story.readingStory),
		isOutdatedReadingStory:
			Boolean(story.readingStory) &&
			!isSupportedReadingStory(story.readingStory),
	};
}

export const localStoryStore: StoryStore = {
	async list(languageId) {
		const stories = await withStore("readonly", (store) => store.getAll());
		return stories
			.filter((story) => !languageId || story.genreId === languageId)
			.map(summary)
			.sort(
				(a, b) =>
					b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
			);
	},

	async get(storyId) {
		return (await withStore("readonly", (store) => store.get(storyId))) ?? null;
	},

	async save(story) {
		const saved = await updateStory(story.id, (current) => ({
			...story,
			createdAt:
				current?.createdAt ??
				current?.updatedAt ??
				story.createdAt ??
				story.updatedAt,
		}));
		return saved as SavedStory;
	},

	async patch(storyId, changes) {
		return updateStory(storyId, (current) =>
			current
				? {
						...current,
						...changes,
						id: storyId,
						createdAt: current.createdAt ?? current.updatedAt,
						updatedAt: new Date().toISOString(),
					}
				: null,
		);
	},

	async delete(storyId) {
		await withStore("readwrite", (store) => store.delete(storyId));
	},
};

/** Read and write together so media updates cannot change the creation date. */
async function updateStory(
	storyId: string,
	update: (current: SavedStory | undefined) => SavedStory | null,
): Promise<SavedStory | null> {
	const database = await openDatabase();
	const transaction = database.transaction(STORIES_STORE, "readwrite");
	const store = transaction.objectStore(STORIES_STORE);
	return new Promise((resolve, reject) => {
		let updated: SavedStory | null = null;
		const request = store.get(storyId);
		request.onsuccess = () => {
			updated = update(request.result as SavedStory | undefined);
			if (updated) store.put(updated);
		};
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed."));
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed."));
		transaction.onabort = () =>
			reject(
				transaction.error ?? new Error("IndexedDB transaction was aborted."),
			);
		transaction.oncomplete = () => resolve(updated);
	});
}
