# Context Evaluation Protocol

## Purpose

HERMENEIA must demonstrate whether adaptive context improves translation rather than assuming that it does.

## Strategies

### T0 — Message only

Translate only the source message.

### T1 — Fixed window

Translate the source message plus a fixed recent-message window.

The chosen N and token cap must be recorded.

### T2 — Adaptive temporal context

Use the HERMENEIA Context Engine to select:

- immediate messages;
- active-episode summary/data;
- relevant prior episodes;
- relevant durable memory.

## Evaluation unit

Each test case should include:

- conversation history;
- timestamped source message;
- source language;
- target language;
- context that a human evaluator considers relevant;
- ambiguity category;
- reference translation or evaluation guidance.

## Required categories

The corpus should cover at least:

- pronoun/reference resolution;
- proper nouns;
- terminology;
- idioms;
- tone/register;
- emoji-dependent intent;
- punctuation/casing-dependent intent;
- humour and laughter forms;
- affection/reassurance;
- frustration/urgency;
- sarcasm where feasible;
- relative time references;
- topic changes;
- long pauses;
- midnight transitions;
- old-topic resumption;
- intentionally irrelevant old context;
- SMS abbreviations and slang;
- ambiguous acronyms;
- domain-specific shorthand;
- cross-domain terminology collisions;
- project/tenant glossary precedence;
- terminology consistency across multiple messages;
- preserve-vs-translate terminology policy;
- country and sub-country locale variants;
- formal/informal formulation differences;
- first-message style bootstrap;
- mid-conversation style shifts;
- explicit locale preference overriding inference;
- code-switching and mixed-language messages;
- typos/phonetic spellings where meaning remains recoverable;
- wrong inference followed by explicit correction;
- summary hallucination / unsupported detail;
- contradictory facts with different validity periods;
- edited/deleted source messages;
- stale async worker completion;
- attempts to promote chat text into privileged policy or glossary state;
- restart with no raw server-side history;
- recovery from a valid sanitised checkpoint;
- corrupt/incompatible checkpoint fallback;
- vague translation complaint vs explicit correction;
- transient-buffer expiry during an active conversation;
- long multi-paragraph messages with progressive translation;
- edits that invalidate previously speculated paragraphs;
- abandoned drafts;
- final reconciliation quality versus full post-Send translation;
- aggressive delete/rewrite behaviour;
- backward cursor edits into previously stable paragraphs;
- paragraph merge/split after speculation;
- stale provider response arriving after a rewrite.

## Metrics

### Human quality

Prefer blinded evaluation when practical.

Rate:

- meaning fidelity;
- naturalness;
- contextual coherence;
- tone preservation;
- pragmatic-intent preservation;
- emoji handling/preservation;
- colloquial meaning preservation;
- register preservation without unnecessary formalisation;
- ambiguity resolution;
- terminology consistency.

### System metrics

Record:

- end-to-end latency;
- provider latency;
- input/output tokens when available;
- estimated cost where meaningful;
- context token count;
- retrieval candidate count;
- selected item count;
- fallback/error rate;
- send-to-translation-ready latency;
- speculative fragment reuse rate;
- speculative invalidation rate;
- abandoned speculative work/cost;
- stale-response discard rate;
- high-churn speculation pause count;
- send reusable fraction.

## Experimental discipline

- T0/T1/T2 must use the same test cases.
- Model/provider versions must be recorded.
- Prompt and context strategy versions must be recorded.
- Do not silently remove failed cases from results.
- Report confidence intervals or uncertainty when sample size permits.
- Separate model improvements from context-engine improvements.

## Contrastive pragmatic tests

The corpus should include minimal pairs where lexical content stays nearly constant while pragmatic signals change, for example:

    "Super."
    "Super !"
    "Super 😂"
    "Super 🙃"

and:

    "Merci"
    "Merci ❤️"
    "Merci..."

These cases test whether HERMENEIA preserves communicative intent without inventing stronger emotion than the source supports.

## Context-integrity evaluation

In addition to translation quality, HERMENEIA must test whether derived context remains correct over time.

Required scenarios include:

- the same derived inference repeated through summaries must not gain authority;
- a corrected acronym/entity meaning must stop influencing future translations;
- a deleted source message must not reappear through cache or memory;
- stale worker output must be rejected;
- translation output must never become evidence for source meaning;
- derived state must recover safely without assuming raw server-side source history;
- a sanitised checkpoint must restore useful context without reconstructing a transcript;
- a vague complaint must reduce trust without inventing a correction;
- explicit correction must produce scoped durable corrective memory.

## Primary question

Does T2 improve contextual translation quality enough to justify its extra latency, complexity and token cost relative to T0 and T1?

A negative result is still useful evidence.


## Progressive long-message evaluation

For long messages, compare at least:

- **L0:** translate entire final message only after Send;
- **L1:** progressively translate stable fragments, then reconcile at Send.

Evaluate:

- final semantic fidelity;
- terminology consistency;
- cross-paragraph reference consistency;
- tone/style consistency;
- send-to-ready latency;
- total provider cost;
- wasted speculative work;
- recipient-visible error rate.

Progressive translation is successful only if it reduces perceived latency without degrading final quality or privacy guarantees.


## Draft-fluidity evaluation

Progressive translation must be tested under realistic editing behaviour, not only linear typing.

Required edit traces include:

- type -> pause -> continue in same sentence;
- type paragraph -> later rewrite paragraph;
- delete a previously speculated paragraph;
- move cursor backward and insert a new antecedent;
- redefine terminology used later in the draft;
- repeatedly edit a high-churn paragraph;
- press Send while stale speculative requests are still in flight.

The final translation must match the final draft, never an earlier revision.


## Mobile/network performance evaluation

Translation quality measurements must be complemented by degraded-network tests.

Minimum profiles:

    Wi-Fi baseline
    RTT 50 / 150 / 500 / 1000 ms
    bandwidth 64 / 256 / 1000 Kbit/s
    jitter
    packet loss 1 / 5 / 10 %
    timeout
    TCP reset
    5s / 30s disconnect
    Wi-Fi -> cellular transition
    cellular -> Wi-Fi transition
    connected network with unreachable HERMENEIA endpoint
    provider 429 / 5xx / timeout
    IPv6-only / NAT64-compatible path
    WebSocket blocked / HTTP fallback
    network-generation change with late old-path response
    app background / kill / relaunch

For each profile record:

    send_to_ready_ms
    bytes_up/down
    retries
    reconnects
    duplicate/lost message count
    speculative work reuse/waste
    outbox recovery time
    recovery mode

Fault-injection tools such as Toxiproxy and container netem/Pumba may be used in reproducible integration tests.


## Pilot harness implementation

The executable V1 selector harness is in `research/eval/harness.py`.

Current executable strategies:

- `T0` — no prior context;
- `T1` — fixed recent causal window;
- `T2_ORACLE` — gold-labelled upper bound used only to validate plumbing.

`T2_ORACLE` is not HERMENEIA's adaptive Context Engine and must never be reported as T2 product performance.

Local/sandbox verification is executed with:

    python scripts/local_ci.py

Provider translation and blinded quality judging will be added after the Translation contract has a concrete adapter implementation.
