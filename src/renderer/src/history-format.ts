import { StateEffect, StateField, type EditorState } from '@codemirror/state'
import { invertedEffects } from '@codemirror/commands'
import { remapLineEndings, type EncodableDoc } from '../../shared/doc'

/** Byte provenance travels through undo/redo with the restore transaction. */
export const historyFormatEffect = StateEffect.define<EncodableDoc | null>()
export const historyFormat = StateField.define<EncodableDoc | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(historyFormatEffect)) value = effect.value
    return value
  }
})
export const historyFormatExtension = [historyFormat, invertedEffects.of(transaction =>
  transaction.effects.some(effect => effect.is(historyFormatEffect))
    ? [historyFormatEffect.of(transaction.startState.field(historyFormat))] : []
)]
export function effectiveFormat(state: EditorState, base: EncodableDoc): EncodableDoc {
  const provenance = state.field(historyFormat, false) ?? base
  const text = state.doc.toString()
  return { text, eol: provenance.eol, bom: provenance.bom,
    lineEndings: remapLineEndings(provenance.text, provenance.lineEndings ?? '', text, provenance.eol) }
}
