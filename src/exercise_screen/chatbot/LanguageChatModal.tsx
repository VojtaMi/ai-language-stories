import {
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { askLanguageTutor, type LanguageTutorChatMessage } from "../../ai";
import { ESPERANTO_KEY_MAP } from "../../esperantoKeyboard";
import { type Language, languageBotImageUrl } from "../../languages";
import {
	readSelectedChatModel,
	saveSelectedChatModel,
} from "../../modelSelection/modelSelectionStore";
import { CHAT_MODELS, type ChatModelId } from "../../models";
import type { StorySegment } from "../types";

interface LanguageChatModalProps {
	language: Language;
	isOpen: boolean;
	onOpen: () => void;
	segments: StorySegment[];
	currentTarget: string | null;
	backgroundIntro?: string;
	onClose: () => void;
	/** Hands learner questions to the story's finish-evidence buffer. */
	onCaptureQuestions: (questions: string[]) => void;
}

type ChatEntry = LanguageTutorChatMessage & { id: string };
type InputMode = "english" | "target";

export function LanguageChatModal({
	language,
	isOpen,
	onOpen,
	segments,
	currentTarget,
	backgroundIntro,
	onClose,
	onCaptureQuestions,
}: LanguageChatModalProps) {
	const [messages, setMessages] = useState<ChatEntry[]>([]);
	const [input, setInput] = useState("");
	const [inputMode, setInputMode] = useState<InputMode>("english");
	const [model, setModel] = useState<ChatModelId>(readSelectedChatModel);
	const [isSending, setIsSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const logRef = useRef<HTMLDivElement>(null);
	const nextMessageIdRef = useRef(0);
	const sessionIdRef = useRef(0);

	const closeChat = useCallback(() => {
		// Fold this session's questions into the story's finish baseline before the
		// transient transcript is cleared.
		if (messages.length > 0) {
			onCaptureQuestions(
				messages
					.filter((message) => message.role === "user")
					.map((message) => message.content),
			);
		}
		sessionIdRef.current += 1;
		nextMessageIdRef.current = 0;
		setMessages([]);
		setInput("");
		setError(null);
		setIsSending(false);
		onClose();
	}, [messages, onClose, onCaptureQuestions]);

	function createMessage(
		role: LanguageTutorChatMessage["role"],
		content: string,
	): ChatEntry {
		const id = nextMessageIdRef.current;
		nextMessageIdRef.current += 1;
		return { id: `language-chat-${id}`, role, content };
	}

	useEffect(() => {
		if (!isOpen) return undefined;
		inputRef.current?.focus();
		function onKey(event: KeyboardEvent) {
			if (event.key === "Escape") closeChat();
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [isOpen, closeChat]);

	useEffect(() => {
		if (!isOpen) return;
		logRef.current?.scrollTo({
			top: logRef.current.scrollHeight,
			behavior: "smooth",
		});
	});

	async function submitQuestion(question: string) {
		const trimmed = question.trim();
		if (!trimmed || isSending) return;

		const nextMessages: ChatEntry[] = [
			...messages,
			createMessage("user", trimmed),
		];
		setMessages(nextMessages);
		setInput("");
		setError(null);
		setIsSending(true);
		const sessionId = sessionIdRef.current;

		try {
			const answer = await askLanguageTutor({
				language,
				segments,
				currentTarget,
				backgroundIntro,
				conversation: messages,
				question: trimmed,
				model,
			});
			if (sessionId !== sessionIdRef.current) return;
			setMessages([...nextMessages, createMessage("assistant", answer)]);
		} catch (err) {
			if (sessionId !== sessionIdRef.current) return;
			const message = err instanceof Error ? err.message : String(err);
			setError(`${language.label} Bot could not answer: ${message}`);
		} finally {
			if (sessionId === sessionIdRef.current) {
				setIsSending(false);
			}
		}
	}

	function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void submitQuestion(input);
			return;
		}

		if (
			inputMode !== "target" ||
			language.id !== "esperanto" ||
			event.metaKey ||
			event.ctrlKey ||
			event.altKey
		) {
			return;
		}

		const mapped = ESPERANTO_KEY_MAP[event.key];
		if (!mapped) return;
		event.preventDefault();
		const inputEl = event.currentTarget;
		const start = inputEl.selectionStart;
		const end = inputEl.selectionEnd;
		const next = `${input.slice(0, start)}${mapped}${input.slice(end)}`;
		setInput(next);
		window.requestAnimationFrame(() => {
			inputEl.selectionStart = start + mapped.length;
			inputEl.selectionEnd = start + mapped.length;
		});
	}

	return (
		<div
			className={`language-chat-assistant${
				isOpen ? " language-chat-assistant--open" : ""
			}`}
		>
			<button
				type="button"
				className="language-bot-character"
				onClick={isOpen ? closeChat : onOpen}
				aria-label={
					isOpen ? `Close ${language.label} Bot` : `Ask ${language.label} Bot`
				}
				title={
					isOpen ? `Close ${language.label} Bot` : `Ask ${language.label} Bot`
				}
			>
				<img src={languageBotImageUrl(language)} alt="" draggable={false} />
			</button>

			{isOpen && (
				<section
					className="language-chat-panel"
					role="dialog"
					aria-label={`${language.label} Bot`}
				>
					<header className="language-chat-header">
						<div className="language-chat-title">
							<span className="language-chat-avatar" aria-hidden="true">
								<img
									src={languageBotImageUrl(language)}
									alt=""
									draggable={false}
								/>
							</span>
							<div>
								<h2>{language.label} Bot</h2>
								<p>Ask about the story, grammar, or vocabulary.</p>
							</div>
						</div>
						<button
							type="button"
							className="language-chat-close"
							onClick={closeChat}
							aria-label={`Close ${language.label} Bot`}
						>
							✕
						</button>
					</header>

					<div className="language-chat-toolbar">
						<div className="language-chat-toggle">
							<button
								type="button"
								data-active={inputMode === "english"}
								onClick={() => setInputMode("english")}
							>
								EN
							</button>
							<button
								type="button"
								data-active={inputMode === "target"}
								onClick={() => setInputMode("target")}
							>
								{language.shortCode}
							</button>
						</div>
						<label className="language-chat-model">
							<span className="language-chat-model-label">Model</span>
							<select
								value={model}
								onChange={(event) => {
									const next = event.target.value as ChatModelId;
									setModel(next);
									saveSelectedChatModel(next);
								}}
							>
								{CHAT_MODELS.map((textModel) => (
									<option key={textModel.id} value={textModel.id}>
										{textModel.label}
									</option>
								))}
							</select>
						</label>
					</div>

					<div className="language-chat-log" ref={logRef}>
						{messages.length === 0 ? (
							<div className="language-chat-empty">
								<p>
									I can explain the current passage or answer follow-up
									questions.
								</p>
							</div>
						) : (
							messages.map((message) => (
								<div
									className={`language-chat-message language-chat-message--${message.role}`}
									key={message.id}
								>
									{message.content}
								</div>
							))
						)}
						{isSending && (
							<div className="language-chat-message language-chat-message--assistant language-chat-message--thinking">
								Thinking...
							</div>
						)}
					</div>

					{error && <p className="language-chat-error">{error}</p>}

					<form
						className="language-chat-form"
						onSubmit={(event) => {
							event.preventDefault();
							void submitQuestion(input);
						}}
					>
						<textarea
							ref={inputRef}
							value={input}
							onChange={(event) => setInput(event.target.value)}
							onKeyDown={handleKeyDown}
							rows={3}
							placeholder={
								inputMode === "target"
									? `Ask in ${language.label}...`
									: "Ask your question..."
							}
						/>
						<button type="submit" disabled={!input.trim() || isSending}>
							Send
						</button>
					</form>
				</section>
			)}
		</div>
	);
}
