# Product North Star — Global Messaging First

**Status:** Product direction  
**Date:** 2026-10-03

## 1. Core product statement

HERMENEIA is not a translation utility with a chat UI.

It is a **global messaging product** whose communication layer understands and translates conversations contextually so well that translation becomes almost invisible to the user.

The product benchmark is therefore two-dimensional:

1. **Messaging quality must meet mainstream consumer expectations.**
2. **Translation quality must exceed isolated sentence-by-sentence translation for real conversations.**

Both are mandatory.

## 2. Messaging is table stakes

Users should not feel that they are using an AI tool each time they send a message.

Core interaction should feel like normal messaging:

    open conversation
    type
    send
    receive
    reply
    react
    continue

Translation must happen around that interaction rather than interrupt it.

A translation feature does not compensate for:

- slow Send;
- message duplication;
- poor offline behaviour;
- bad reconnects;
- typing lag;
- delayed conversation rendering;
- unstable mobile background behaviour.

## 3. Translation should become invisible

The desired user experience is:

    sender writes naturally in language A
          |
          v
    HERMENEIA understands context
          |
          v
    recipient reads naturally in language B

The recipient should not need to:

    copy
    switch application
    paste
    translate
    interpret
    copy back
    return to chat

The sender should not need to simplify their language for a translator.

## 4. No mandatory pivot language

HERMENEIA must not architecturally assume:

    source -> English -> target

or:

    source -> French -> target

Language pairs are first-class.

The Provider Router may internally select models that use their own implementation strategy, but HERMENEIA's domain model must represent:

    source language / locale
    target language / locale
    context
    terminology
    style

without a privileged pivot language.

Where direct pair quality is weak, routing/fallback strategy must be explicit and benchmarked.

## 5. Global from the domain model

The architecture must not encode French-first assumptions.

Global readiness includes:

- Unicode correctness;
- RTL support;
- CJK segmentation;
- scripts without whitespace segmentation;
- mixed-language/code-switching;
- country and sub-country locale variants;
- regional slang;
- professional terminology;
- address-form differences;
- different punctuation conventions;
- emoji/grapheme preservation;
- plural/gender/formality systems.

The first implementation may support a smaller language set, but the data model and APIs must not need redesign to expand globally.

## 6. Mobile-first product target

The research MVP may start as a responsive web application.

The production North Star is mobile-first because messaging usage is naturally mobile-heavy.

Therefore the core protocol and domain logic must support later native Android/iOS clients without depending on browser-specific semantics.

Mobile constraints are architectural constraints now:

    intermittent network
    background suspension
    local outbox
    push wake-up
    low-end devices
    metered links
    battery/radio cost

## 7. Multi-person multilingual conversations

The initial MVP may remain 1:1 for experimental control.

The product North Star includes group conversations where each participant can receive the same original message in their own preferred language.

Conceptually:

    original message
          |
          +--> recipient A -> es-CO
          +--> recipient B -> en-GB
          +--> recipient C -> pt-BR
          +--> recipient D -> ja-JP

All translations must derive from the same immutable source event and compatible ContextSnapshot, while recipient-specific locale/style policies may differ.

This must not require the sender to choose one shared translation language.

## 8. Translation trust

A fast translation is useless if users constantly verify it in another tool.

A key product outcome is therefore reduction of **translation verification behaviour**.

Potential research/product indicators:

- translation problem reports;
- reveal-original frequency;
- correction frequency;
- external-copy intent where measurable with privacy-safe methods;
- repeated retranslation requests;
- conversation abandonment after translation issues;
- user-rated trust.

These are product metrics to validate, not assumptions.

## 9. Quality, speed, trust

The product has three non-negotiable axes:

### Quality

    meaning
    context
    terminology
    tone
    locale
    jargon
    slang
    references
    conversation continuity

### Speed

    typing remains instant
    Send remains instant-feeling
    translation latency is bounded
    progressive work reduces long-message delay
    weak networks degrade gracefully

### Trust

    original remains accessible through authorised client/customer history
    no random durable memory updates
    corrections are scoped and traceable
    translations are never promoted to source truth
    privacy behaviour is explainable
    failure is visible rather than silently fabricated

Optimising one axis by sacrificing another is not acceptable.

## 10. Global product vs global market proof

HERMENEIA should be technically capable of serving users internationally from the start.

That is different from claiming that global commercial demand is already proven.

Commercial validation must separately establish:

- who has the strongest translation pain;
- which language pairs matter first;
- consumer vs business willingness to pay;
- enterprise deployment/privacy requirements;
- which integrations are actually demanded.

The architecture should preserve global optionality while product discovery determines sequencing.

## 11. Competitive framing

HERMENEIA should not compete with translation products only on raw translation quality.

Its differentiated system is:

    messaging UX
      +
    Context Engine
      +
    Corrective Memory
      +
    terminology/locale/style
      +
    network/mobile orchestration
      +
    provider-independent translation

The goal is to remove translation as a workflow step inside multilingual communication.

## 12. Product invariant

A user should never need to think:

> "I am using a translator before I can talk to this person."

The intended experience is:

> "I am talking to this person."
