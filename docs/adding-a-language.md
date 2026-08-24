# Adding a language

Adding a language is a curated product and pedagogy workflow, not just a
translation change. The canonical procedure lives in the repository-local
[Codex `language-addition` skill](../.codex/skills/language-addition/SKILL.md).

The skill guides Codex through the language registry, beginner-level guidance,
source poster and bot assets, AVIF conversion, validation, tests, and browser
verification. When Codex is available, it can use the native `imagegen` skill
to create and iterate the source visuals before running the repository's
optimizer. The workflow can also accept API-generated or user-provided source
images, so it is not tied to one image-generation tool.

The app serves optimized AVIF assets from `public/images/`; source PNGs belong
under `assets/language-images/`. Run `npm run images:optimize` after adding or
changing the source poster or bot images.
