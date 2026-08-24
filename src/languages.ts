import type { NextStoryBrief } from "./nextStoryBrief";

interface LanguageDefinition<Id extends string = string> {
	id: Id;
	label: string;
	shortCode: string;
	teachingTopics: string;
	absoluteBeginnerGuidance: string;
	grammarInvariants: string;
	starterFocus: string;
	calibrationSnippets: string[];
	recapTitle: string;
}

function defineLanguages<const Id extends string>(
	languages: LanguageDefinition<Id>[],
): LanguageDefinition<Id>[] {
	return languages;
}

export const languages = defineLanguages([
	{
		id: "esperanto",
		label: "Esperanto",
		shortCode: "EO",
		teachingTopics:
			"vocabulary, roots, affixes, grammar, pronunciation, and why sentences mean what they mean",
		absoluteBeginnerGuidance:
			"Prefer the basic tense required by language.focus; otherwise prefer present-tense copular, positional, and intransitive constructions. Repeat explicit nouns when that is clearer than pronouns or complex references. Avoid plurals and direct objects unless language.focus introduces them; rephrase grammatically instead of dropping required endings.",
		grammarInvariants:
			"Never simplify by dropping required accusative, plural, or agreement endings.",
		starterFocus:
			"Simple present-tense sentences with concrete beginner words; avoid plurals and direct objects.",
		calibrationSnippets: [
			"Petro estas viro. Petro sidas en ĝardeno. Simo estas hundo. Simo dormas apud Petro.",
		],
		recapTitle: "Eta praktiko",
	},
	{
		id: "german",
		label: "German",
		shortCode: "DE",
		teachingTopics:
			"vocabulary, cases, gender and articles, verb person and tense, word order, separable verbs, and pronunciation",
		absoluteBeginnerGuidance:
			"Prefer present tense. Keep all nouns capitalized, use der/die/das and adjective forms correctly, and use nominative, accusative, and dative cases correctly. Keep main clauses verb-second, subordinate clauses verb-final, and use separable verbs naturally; avoid genitive, Konjunktiv, and complex subordination.",
		grammarInvariants:
			"Use the three genders and der/die/das with correct adjective endings; use nominative, accusative, and dative correctly; keep main clauses verb-second and subordinate clauses verb-final; use separable verbs naturally; capitalize every noun. Prefer present tense and avoid genitive, Konjunktiv, and complex subordination.",
		starterFocus:
			"Simple present-tense German sentences with concrete beginner words; practise the three genders and articles (`der`, `die`, `das`) with basic nominative and accusative forms.",
		calibrationSnippets: [
			"Peter ist ein Mann. Peter ist in einem Garten. Bello ist ein Hund. Bello schläft neben Peter.",
		],
		recapTitle: "Kleine Übung",
	},
	{
		id: "spanish",
		label: "Spanish",
		shortCode: "ES",
		teachingTopics:
			"vocabulary, gender and agreement, verb conjugation and tense, ser and estar, pronunciation, and why sentences mean what they mean",
		absoluteBeginnerGuidance:
			"Prefer the basic tense required by language.focus; otherwise prefer present-tense copular, positional, and intransitive constructions. Repeat explicit nouns when that is clearer than pronouns or complex references. Keep noun/adjective gender and number agreement correct, conjugate verbs correctly, and use ser and estar appropriately.",
		grammarInvariants:
			"Maintain noun/adjective gender and number agreement, correct verb conjugation, and correct use of ser and estar.",
		starterFocus:
			"Simple present-tense Spanish sentences with concrete beginner words; practise basic gender and number agreement and the verbs `ser` and `estar`.",
		calibrationSnippets: [
			"Pedro es un hombre. Pedro está en un jardín. Sol es un perro. Sol duerme junto a Pedro.",
		],
		recapTitle: "Práctica breve",
	},
	{
		id: "dutch",
		label: "Dutch",
		shortCode: "NL",
		teachingTopics:
			"vocabulary, de and het articles, verb conjugation and tense, main-clause word order, separable verbs, pronunciation, and why sentences mean what they mean",
		absoluteBeginnerGuidance:
			"Prefer the present tense and short subject-verb-object sentences. Use de, het, and een with common beginner nouns, keep adjective forms natural, and keep main clauses verb-second. Use common separable verbs only when their split is clear; avoid past tense, subordinate-clause inversion, relative clauses, and other complex subordination until introduced by language.focus.",
		grammarInvariants:
			"Use de, het, and een naturally with common nouns; keep present-tense verb conjugation and main-clause verb-second order correct; use separable verbs with correct particle placement when they appear. Avoid past tense and complex subordination unless language.focus explicitly introduces them.",
		starterFocus:
			"Simple present-tense Dutch sentences with concrete beginner words; practise `de`, `het`, and `een` with basic subject-verb-object sentences and main-clause verb-second order.",
		calibrationSnippets: [
			"Pieter is een man. Pieter is in een tuin. Saar is een hond. Saar slaapt naast Pieter.",
		],
		recapTitle: "Kleine oefening",
	},
	{
		id: "finnish",
		label: "Finnish",
		shortCode: "FI",
		teachingTopics:
			"vocabulary, pronunciation, vowel harmony, consonant gradation, case endings, verb conjugation, and why sentences mean what they mean",
		absoluteBeginnerGuidance:
			"Prefer the present tense and short sentences with explicit subjects. Finnish has no articles or grammatical gender: do not invent either. Use basic nominative forms first, then introduce clear locative forms such as -ssa/-ssä and simple possessive or object forms only when language.focus requires them. Keep vowel harmony and consonant gradation natural; avoid dense case chains, conditional or potential mood, participles, and complex subordination.",
		grammarInvariants:
			"Do not add articles or grammatical gender. Keep vowel harmony, consonant gradation, verb-person endings, and case endings correct; use the partitive and total object appropriately when objects appear. Prefer present tense and avoid complex subordination unless language.focus explicitly introduces it.",
		starterFocus:
			"Simple present-tense Finnish sentences with concrete beginner words; practise article-free noun phrases, basic verb-person endings, and a small set of nominative and -ssa/-ssä forms.",
		calibrationSnippets: [
			"Aino on nainen. Aino on puutarhassa. Sisu on koira. Sisu nukkuu Ainon vieressä.",
		],
		recapTitle: "Pieni harjoitus",
	},
]);

export type LanguageId = (typeof languages)[number]["id"];
export type Language = LanguageDefinition<LanguageId>;

export const DEFAULT_LANGUAGE = languages[0];

export function isLanguageId(value: unknown): value is LanguageId {
	return languages.some((language) => language.id === value);
}

export function getLanguage(id: LanguageId): Language {
	const language = languages.find((candidate) => candidate.id === id);
	if (!language) throw new Error(`Unknown language: ${id}`);
	return language;
}

export function languageStorySystemPrompt(language: Language): string {
	return `Create an engaging ${language.label} story of your choice. Write the story prose in clear, natural ${language.label} for a true beginner; keep explanations and metadata in English.`;
}

export function languageHeroImageUrl(language: Language): string {
	return `/images/${language.id}-story-hero.png`;
}

export function languageBotImageUrl(language: Language): string {
	return `/images/${language.id}-story-bot.png`;
}

export function languageFaviconUrl(language: Language): string {
	return `/favicon-${language.id}.svg?v=5`;
}

export function languageTtsInstructions(language: Language): string {
	return `Keep ${language.label} pronunciation clear, natural, and learner-friendly.`;
}

export function starterBriefForLanguage(language: Language): NextStoryBrief {
	return {
		themeSuggestion: "",
		narrativeScale: "minimal",
		language: {
			focus: language.starterFocus,
			progression: "establish",
			complexity: "absolute beginner",
			calibrationSnippets: [...language.calibrationSnippets],
		},
	};
}
