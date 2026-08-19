import { describe, expect, it } from 'vitest'
import { SpecShapeError } from '@/lib/spec/schema'
import {
  parseSpecChangeDraft,
  parseStoredChange,
  sealChange,
  SPEC_CHANGE_JSON_SCHEMA,
} from '@/lib/spec/change'

/** What the model is asked for. No `shape`, no `based_on_version` — both are
 *  the server's to write. */
const DRAFT = {
  change_summary: 'Adds a weekly average and drops the time-of-day panel.',
  changes: [
    {
      action: 'add',
      target: 'panel',
      name: 'Weekly average',
      description:
        'On the main screen, under the streak. Averages the last seven logged days and ignores days before they started.',
    },
    {
      action: 'remove',
      target: 'panel',
      name: 'Time of day',
      description: 'They stopped using it.',
    },
  ],
  data_requirements: [
    { table: 'walk_log', purpose: 'One row per logged day.', status: 'unchanged' },
  ],
  open_questions: [],
}

describe('parseSpecChangeDraft', () => {
  it('accepts a well-formed draft', () => {
    const draft = parseSpecChangeDraft(DRAFT)
    expect(draft.changes).toHaveLength(2)
    expect(draft.changes[0]!.action).toBe('add')
    expect(draft.changes[0]!.target).toBe('panel')
    expect(draft.changes[1]!.name).toBe('Time of day')
    expect(draft.data_requirements[0]!.status).toBe('unchanged')
  })

  it('rejects an empty changes list', () => {
    // A spec that changes nothing is not a proposal. The agent should not
    // have been called, and a row saying so is permanent.
    expect(() => parseSpecChangeDraft({ ...DRAFT, changes: [] })).toThrow(/changes is empty/)
  })

  it('rejects an unknown action', () => {
    const bad = { ...DRAFT, changes: [{ ...DRAFT.changes[0], action: 'tweak' }] }
    expect(() => parseSpecChangeDraft(bad)).toThrow(/action is not one of add, change, remove/)
  })

  it('rejects an unknown target', () => {
    const bad = { ...DRAFT, changes: [{ ...DRAFT.changes[0], target: 'value' }] }
    expect(() => parseSpecChangeDraft(bad)).toThrow(/target is not one of screen, panel/)
  })

  it('rejects a blank description', () => {
    const bad = { ...DRAFT, changes: [{ ...DRAFT.changes[0], description: '   ' }] }
    expect(() => parseSpecChangeDraft(bad)).toThrow(/description is empty/)
  })

  it('rejects a model-authored shape tag', () => {
    // The tag is what readStoredSpec discriminates on. A model that could
    // write it could make a row claim to be something it is not, permanently.
    expect(() => parseSpecChangeDraft({ ...DRAFT, shape: 'change' })).toThrow(/shape is supplied by the server/)
  })

  it('rejects a model-authored based_on_version', () => {
    expect(() => parseSpecChangeDraft({ ...DRAFT, based_on_version: 3 })).toThrow(
      /based_on_version is supplied by the server/,
    )
  })

  it('names the failing path', () => {
    const bad = { ...DRAFT, changes: [DRAFT.changes[0], { ...DRAFT.changes[1], name: '' }] }
    // The message goes back to the model on the retry attempt, so it has to
    // say WHICH entry failed, not just that one did.
    expect(() => parseSpecChangeDraft(bad)).toThrow(/changes\[1\]\.name/)
  })
})

describe('sealChange and parseStoredChange', () => {
  it('round-trips through JSON', () => {
    const sealed = sealChange(parseSpecChangeDraft(DRAFT), 2)
    expect(sealed.shape).toBe('change')
    expect(sealed.based_on_version).toBe(2)

    const read = parseStoredChange(JSON.stringify(sealed))
    expect(read).toEqual(sealed)
  })

  it('accepts a null lineage pointer for a first version', () => {
    const sealed = sealChange(parseSpecChangeDraft(DRAFT), null)
    expect(parseStoredChange(JSON.stringify(sealed)).based_on_version).toBeNull()
  })

  it('refuses a stored row that is not tagged', () => {
    const untagged = { ...sealChange(parseSpecChangeDraft(DRAFT), 1), shape: undefined }
    expect(() => parseStoredChange(JSON.stringify(untagged))).toThrow(SpecShapeError)
  })

  it('refuses a non-integer lineage pointer', () => {
    const sealed = { ...sealChange(parseSpecChangeDraft(DRAFT), 1), based_on_version: 1.5 }
    expect(() => parseStoredChange(JSON.stringify(sealed))).toThrow(/based_on_version/)
  })

  it('throws SpecShapeError on unparsable JSON', () => {
    expect(() => parseStoredChange('{')).toThrow(SpecShapeError)
  })
})

describe('SPEC_CHANGE_JSON_SCHEMA', () => {
  it('requires every field and forbids extras', () => {
    // Structured outputs constrain the response; a field the model may omit
    // is a field it will omit. additionalProperties:false is what stops it
    // inventing a `screens` key that would make readStoredSpec pick the
    // wrong arm.
    expect(SPEC_CHANGE_JSON_SCHEMA.additionalProperties).toBe(false)
    expect(SPEC_CHANGE_JSON_SCHEMA.required).toEqual([
      'change_summary',
      'changes',
      'data_requirements',
      'open_questions',
    ])
  })
})
