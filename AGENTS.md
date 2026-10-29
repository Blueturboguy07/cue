## publik API
- Base URL: https://publikhq.com/api/v1 (OpenAI Chat Completions, Responses, Anthropic Messages)
- Models: publik-fast, publik-balanced, publik-smart only; never a vendor model name
- Key: per-install `pk_` from POST /installs, stored at the publik credential path; env PUBLIK_API_KEY / PUBLIK_API_BASE_URL override
- App token: src/publik-build.json `appToken`, committed empty and filled from the PUBLIK_APP_TOKEN secret by release.yml; PUBLIK_APP_TOKEN env overrides at runtime
- Tier per call: `publik.planCall()` / `MODE_TIERS` in src/publik.js pick the cheapest tier each feature needs; unlinked installs never get publik-smart
- Log: one `[publik] mode= tier= model= charge= request= ms= status=` line per call (`publik.formatCallLog`), also recorded as event `publik_call`
- 402: show error.message plus error.top_up_url only
- Never print or log a key
- Docs: https://publikhq.com/llms.txt, https://publikhq.com/developers, https://publikhq.com/skills/api.md
