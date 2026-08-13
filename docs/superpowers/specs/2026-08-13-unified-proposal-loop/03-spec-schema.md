# Spec schema — versioned, whole-surface, diffable

**For Claude Code.** Defines the shape of a spec version. The structured payload is
the source of truth, stored in the specs table and schema-validated at emission;
`spec.md` and `mockup.html` are rendered *from* it (spec.md for humans and the admin
portal, the payload for diffing and for driving builds). Implement validation with
whatever the repo already uses (zod is the natural fit in this stack).

## Design requirements the schema serves

1. **Whole-surface:** a version describes the entire dashboard, so "build to vN" is
   always a complete instruction.
2. **Diffable:** stable string ids on screens and panels, so a diff between versions
   can say "panel `eating_out` changed its window" vs. "panel `three_point` is new."
   Ids are assigned at first appearance and never reused or renamed; display titles
   may change freely.
3. **Per-value sourcing:** data provenance is declared per value, not per panel or
   per dashboard — panels routinely mix synced, entered, and derived data.
4. **Named handoff:** open questions are a first-class field, the formal PM→Nico
   channel for known unknowns.

## Schema (TypeScript-flavored; translate to zod)

```ts
type SpecVersion = {
  version: number;                  // 1-based, assigned by the server on append
  based_on_version: number | null;  // null for v1
  change_summary: string;           // human-readable, drives the preview card
                                    // and the deploy announcement; for v1,
                                    // describes the whole dashboard briefly
  screens: Screen[];                // min 1
  data_requirements: DataRequirement[]; // new/changed user tables this version implies
  open_questions: string[];         // unresolved items for Nico; may be empty
};

type Screen = {
  id: string;                       // stable slug, e.g. "money", "training"
  title: string;
  order: number;
  panels: Panel[];                  // min 1
};

type Panel = {
  id: string;                       // stable slug, e.g. "eating_out", "three_point"
  title: string;
  intent: string;                   // the question this panel answers, in the
                                    // user's terms — one or two sentences
  display: string;                  // what the tile shows and how: trend line,
                                    // single number vs. usual, streak, table, etc.
  context_of_use?: string;          // when/where/device, when it shaped the design
  values: ValueSpec[];              // every number/series the panel renders
  entry?: EntryWidget;              // present iff the panel accepts input
};

type ValueSpec =
  | { kind: "synced";
      module: string;               // e.g. "plaid"
      description: string;          // what is taken from the module, in words —
                                    // tables/fields/filters at whatever precision
                                    // discovery produced
    }
  | { kind: "entered";
      description: string;          // what the person records and how often,
                                    // including the realistic-frequency agreement
    }
  | { kind: "derived";
      description: string;          // the computation, in words
      inputs: string[];             // ids/descriptions of the values it derives from
    };

type EntryWidget = {
  description: string;              // e.g. "two fields after practice: makes,
                                    // attempts; one save tap"
  fields: { name: string; type: "number" | "text" | "boolean" | "date" | "choice";
            choices?: string[] }[];
  annotates?: string;               // if this widget labels synced rows rather than
                                    // creating standalone data: which synced values
                                    // it annotates. Annotation data lives in user
                                    // tables keyed to synced rows — never edits to
                                    // shared-module tables.
};

type DataRequirement = {
  table: string;                    // user-table name (custom or annotation table)
  purpose: string;
  status: "new" | "changed" | "unchanged";
};
```

## Rules

- **Validation gate:** an emitted version failing schema validation never renders to
  the user; the generation call retries with the validation error attached.
- **Additional invariants to enforce beyond shape:** unique ids within a version;
  every `derived` value's `inputs` reference values that exist in the version;
  every `annotates` reference points at a `synced` value; ids present in the prior
  confirmed version and absent in the new one constitute deletions and must be
  reflected in `change_summary`.
- **Descriptions are prose on purpose.** This schema is a contract between the
  agent and a human+Claude Code build step, not a codegen input format. Precision
  lives in the words; the structure exists for stability, diffing, and validation —
  resist the urge to schematize `display` or the sourcing descriptions further
  until the request-diff data says which parts recur.
- **Diffing:** compute diffs by id — screens/panels added, removed, or with changed
  fields. Store or derive the diff alongside each version for the metrics pipeline;
  `change_summary` is the human gloss, the structural diff is the data.
- **Rendering:** `spec.md` is generated from the payload (stable section order:
  change summary, then screens/panels with sourcing, then data requirements, then
  open questions). The admin portal renders spec.md as today; the mockup call
  consumes the payload.

## Migration note

If existing confirmed specs are markdown-only, either backfill them into the schema
(fine to do by hand for the pilot's user count) or mark pre-schema versions as
legacy and start structured at the next version — a ledger decision. Version
numbering must remain continuous either way.
