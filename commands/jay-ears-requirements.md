---
description: Ideate and write EARS (Easy Approach to Requirements Syntax) requirements interactively
argument-hint: [feature-or-topic]
---

# EARS Requirements Ideation

Guide the user through creating well-formed requirements using the EARS (Easy Approach to Requirements Syntax) notation. EARS provides five patterns that eliminate ambiguity and vagueness in natural-language requirements.

## EARS Patterns Reference

Use these five patterns when crafting requirements. Each pattern has a specific sentence structure:

### 1. Ubiquitous (unconditional)
**Template:** The `<system>` shall `<action>`.
**Use when:** The requirement is always active with no trigger or condition.
**Example:** The system shall display timestamps in UTC format.

### 2. Event-driven
**Template:** When `<trigger>`, the `<system>` shall `<action>`.
**Use when:** The requirement is initiated by a detectable event.
**Example:** When the user submits a form, the system shall validate all required fields.

### 3. State-driven
**Template:** While `<state>`, the `<system>` shall `<action>`.
**Use when:** The requirement applies as long as a condition holds true.
**Example:** While the system is in maintenance mode, the system shall reject all write operations.

### 4. Unwanted behavior
**Template:** If `<unwanted condition>`, then the `<system>` shall `<action>`.
**Use when:** Handling failures, errors, or undesirable situations.
**Example:** If the database connection is lost, then the system shall retry the connection three times before alerting the operator.

### 5. Optional feature
**Template:** Where `<feature>` is supported, the `<system>` shall `<action>`.
**Use when:** The requirement only applies if a particular feature or configuration is present.
**Example:** Where multi-factor authentication is enabled, the system shall require a second factor before granting access.

### Complex (combined patterns)
Patterns can be combined for more nuanced requirements:
**Example:** While the system is in active mode, when the user clicks save, the system shall persist the document to the database within 2 seconds.

## Ideation Process

Follow these steps to help the user develop EARS requirements:

### Step 1: Understand the Domain

If the user provided a feature or topic via `$ARGUMENTS`, use it as the starting point. Otherwise, ask what system, feature, or area they want to write requirements for.

Ask clarifying questions to understand:
- What is the system or component being specified?
- Who are the actors (users, external systems, administrators)?
- What is the high-level goal or capability?

Keep questions focused — ask no more than 2-3 at a time.

### Step 2: Brainstorm Scenarios

Help the user identify scenarios that need requirements by exploring:
- **Happy paths**: What should happen under normal operation?
- **Triggers and events**: What user actions or system events occur?
- **States and modes**: Does the system have different operational states?
- **Error cases**: What can go wrong? How should the system respond?
- **Optional features**: Are there configurable or optional capabilities?
- **Edge cases**: What about boundaries, limits, timeouts, concurrency?

Present scenario ideas as a bulleted list and ask the user which ones to develop into requirements and whether any are missing.

### Step 3: Draft Requirements

For each accepted scenario, draft a requirement using the most appropriate EARS pattern:
- Assign each requirement a unique ID (e.g., REQ-001, REQ-002)
- Choose the correct EARS pattern based on the nature of the requirement
- Use precise, unambiguous language — avoid "should", "may", "might", "could"
- Always use "shall" for mandatory requirements
- Specify measurable criteria where possible (times, counts, thresholds)
- Keep each requirement atomic — one "shall" per requirement

Present the drafted requirements in a table:

| ID | Pattern | Requirement |
|----|---------|-------------|
| REQ-001 | Event-driven | When ... the system shall ... |

### Step 4: Review and Refine

After presenting drafted requirements, ask the user to review them. For each requirement, check:
- Is the correct EARS pattern used?
- Is the language precise and testable?
- Are there missing conditions, triggers, or states?
- Should any requirement be split into multiple atomic requirements?
- Are there gaps — scenarios not yet covered?

Iterate on the requirements based on user feedback. Offer to add, remove, modify, or split requirements.

### Step 5: Output Final Requirements

Once the user is satisfied, produce the final requirements document in clean markdown with:
- A summary header (system name, feature area, date)
- The complete requirements table with ID, EARS pattern type, and full requirement text
- A traceability note if the user wants to link requirements to user stories or tickets

## Quality Checklist

Before finalizing, verify each requirement against these criteria:
- Uses "shall" (not "should", "will", "may", or "must")
- Follows one of the five EARS patterns exactly
- Is atomic (single "shall" per requirement)
- Is testable and verifiable
- Contains no ambiguous terms ("appropriate", "reasonable", "fast", "user-friendly")
- Specifies the system or component name explicitly
- Includes measurable acceptance criteria where applicable

## Begin

Start the ideation session now. If the user provided `$ARGUMENTS`, begin by acknowledging the topic and asking 2-3 targeted clarifying questions to understand the scope. If no arguments were provided, ask what system or feature they want to write requirements for.
