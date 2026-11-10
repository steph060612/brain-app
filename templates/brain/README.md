---
title: README
updated: {{TODAY}}
---

# Brain — {{NAME}}'s Portable Memory

---

## PURPOSE

This is {{NAME}}'s portable memory. Read README.md first, then profile.md and preferences.md, then only the files relevant to the current task. Do not read the whole brain by default.

---

## FOLDERS

- **projects/\<project-name\>/** — active projects only. Each contains:
  - `state.md` — current status and the single next step
  - `decisions.md` — dated decision log, one entry per decision (date, decision, reason)
  - `context.md` — stable background that rarely changes
- **archive/\<project-name\>/** — paused or finished projects. Larger projects use the same three files; small ideas may have only state.md. Ignore unless {{NAME}} asks about one.
- **people/\<name\>.md** — one file per person, relationship context only.
- **topics/\<topic\>.md** — one file per subject that is not a project (training, tech setup, interests).
- **inbox/** — unsorted notes waiting to be filed. Never treat inbox content as confirmed.
  - Inbox files carry a target: field naming the file they belong to. They enter the brain only through approval.

---

## FILE FORMAT

Every file starts with frontmatter:

```yaml
---
title: [name]
updated: [YYYY-MM-DD]
---
```

Use short bullet points. Use lowercase-hyphenated names for files and folders.
A "permalink" line in the frontmatter is added automatically by Basic Memory. Never write or edit it by hand.

---

## WRITING RULES

- Store distilled facts, decisions, and current state. Never raw chat transcripts.
- Every line must be something {{NAME}} stated or confirmed. Assistant suggestions are not facts until {{NAME}} confirms them.
- Date anything that can go stale.
- When a fact changes, update it and keep the history in one line, e.g. "Status: in promotion (previously in development)".

---

## UPDATE PROTOCOL

When {{NAME}} says "close session", output proposed changes in this exact format, one block per file:

```text
### FILE: [relative path]
### ACTION: create | append | replace-section [section heading] | replace-line | frontmatter
[content]
```

For replace-line, give the exact OLD line and the NEW line. For frontmatter, give only the fields to change. Never use frontmatter to edit the permalink.

Nothing is written without {{NAME}}'s approval.

---

## NEVER STORE

Account numbers, card numbers, passwords, government identification numbers, financial positions or balances.

---

## WORKING RULES FOR ASSISTANTS

- Before helping with a plan, check it against the project's state.md and decisions.md, including its Open risks section. Flag contradictions and weak reasoning first.
- Never describe {{NAME}}, their experience or their results more strongly than these files state. Ask instead of inflating.
- Propose changes only to brain files. Anything else goes to {{NAME}} as a plain note.
- state.md may have an "## Open risks" section: known risks for the project, one bullet each, dated.
