import { useEffect, useState } from "react";
import {
	fetchLearnerPreferences,
	fetchProviderAvailability,
	updateLearnerPreferences,
} from "../ai";
import type { LearnerPreferences } from "../learnerState";
import {
	readSelectedChatModel,
	readSelectedNarrationModel,
	saveSelectedChatModel,
	saveSelectedNarrationModel,
} from "../modelSelection/modelSelectionStore";
import {
	STORY_GENERATION_PRESETS,
	type StoryGenerationPresetId,
	TEXT_MODELS,
	type TextModelId,
} from "../models";
import {
	isTextModelAvailable,
	isTtsModelAvailable,
	type ProviderAvailability,
} from "../providerAvailability";
import { TTS_MODELS, type TtsModelId } from "../ttsModel";

interface SettingsPanelProps {
	storyGenerationPreset: StoryGenerationPresetId;
	onStoryGenerationPresetChange: (preset: StoryGenerationPresetId) => void;
	onClose: () => void;
}

type EditablePreferences = Pick<LearnerPreferences, "prefer" | "avoid">;

type PreferencesDraft = Record<keyof EditablePreferences, string>;

function lines(values: string[]): string {
	return values.join("\n");
}

function list(value: string): string[] {
	return value
		.split("\n")
		.map((item) => item.trim())
		.filter(Boolean);
}

export function SettingsPanel({
	storyGenerationPreset,
	onStoryGenerationPresetChange,
	onClose,
}: SettingsPanelProps) {
	const [chatModel, setChatModel] = useState<TextModelId>(
		readSelectedChatModel,
	);
	const [narrationModel, setNarrationModel] = useState<TtsModelId>(
		readSelectedNarrationModel,
	);
	const [draft, setDraft] = useState<PreferencesDraft | null>(null);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [availability, setAvailability] = useState<ProviderAvailability | null>(
		null,
	);

	useEffect(() => {
		void fetchProviderAvailability()
			.then((loaded) => {
				setAvailability(loaded);
				if (!loaded.gemini && narrationModel !== "openai") {
					setNarrationModel("openai");
					saveSelectedNarrationModel("openai");
				}
			})
			.catch(() => setMessage("Could not determine available AI providers."));
	}, [narrationModel]);

	useEffect(() => {
		let cancelled = false;
		void fetchLearnerPreferences()
			.then((loaded) => {
				if (cancelled) return;
				setDraft({
					prefer: lines(loaded.prefer),
					avoid: lines(loaded.avoid),
				});
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setMessage(error instanceof Error ? error.message : String(error));
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	function updateField(field: keyof EditablePreferences, value: string) {
		setDraft((current) => (current ? { ...current, [field]: value } : current));
	}

	async function save() {
		if (!draft) return;
		setSaving(true);
		setMessage(null);
		try {
			const preferences: EditablePreferences = {
				prefer: list(draft.prefer),
				avoid: list(draft.avoid),
			};
			await updateLearnerPreferences(preferences);
			saveSelectedChatModel(chatModel);
			saveSelectedNarrationModel(narrationModel);
			setMessage("Settings saved.");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div
			className="settings-panel"
			role="dialog"
			aria-modal="true"
			aria-labelledby="settings-title"
		>
			<div className="settings-panel__card">
				<div className="settings-panel__header">
					<h2 id="settings-title">Settings</h2>
					<button
						type="button"
						className="settings-panel__close"
						onClick={onClose}
					>
						Close
					</button>
				</div>
				<div className="settings-panel__models">
					<label>
						Story generation
						<select
							value={storyGenerationPreset}
							onChange={(event) =>
								onStoryGenerationPresetChange(
									event.target.value as StoryGenerationPresetId,
								)
							}
						>
							{STORY_GENERATION_PRESETS.map((item) => (
								<option key={item.id} value={item.id}>
									{item.label}
								</option>
							))}
						</select>
					</label>
					<label>
						Tutor model
						<select
							value={chatModel}
							onChange={(event) =>
								setChatModel(event.target.value as TextModelId)
							}
						>
							{TEXT_MODELS.map((item) => (
								<option
									key={item.id}
									value={item.id}
									disabled={
										availability !== null &&
										!isTextModelAvailable(item.id, availability)
									}
								>
									{item.label}
								</option>
							))}
						</select>
					</label>
					<label>
						Narration model
						<select
							value={narrationModel}
							onChange={(event) =>
								setNarrationModel(event.target.value as TtsModelId)
							}
						>
							{TTS_MODELS.map((item) => (
								<option
									key={item.id}
									value={item.id}
									disabled={
										availability !== null &&
										!isTtsModelAvailable(item.id, availability)
									}
								>
									{item.label}
								</option>
							))}
						</select>
					</label>
				</div>
				<p className="settings-panel__hint">
					Changes apply to the next generated reading story.
				</p>
				<h3>Story preferences</h3>
				<p className="settings-panel__hint">
					One preference per line. Story preferences are shared across all
					languages.
				</p>
				{draft ? (
					<>
						<label>
							Prefer
							<textarea
								className="settings-panel__textarea--list"
								value={draft.prefer}
								onChange={(event) => updateField("prefer", event.target.value)}
							/>
						</label>
						<label>
							Avoid
							<textarea
								className="settings-panel__textarea--list"
								value={draft.avoid}
								onChange={(event) => updateField("avoid", event.target.value)}
							/>
						</label>
					</>
				) : (
					<p>Loading preferences…</p>
				)}
				<div className="settings-panel__footer">
					{message && <span role="status">{message}</span>}
					<button
						type="button"
						className="lesson-hero__start"
						onClick={() => void save()}
						disabled={!draft || saving}
					>
						{saving ? "Saving…" : "Save settings"}
					</button>
				</div>
			</div>
		</div>
	);
}
