import { DefaultLinker, type AstNodeDescription, type LinkingError, type ReferenceInfo } from 'langium';
import { nearestName } from '../util/suggest.js';

/**
 * Langium's linker, with a suggestion on names that do not resolve.
 *
 * An unknown selector type fails here, not in Lanzer's own validation: it is a reference that
 * finds nothing in scope. The scope already holds every name the author could have meant (for a
 * selector, every type of the imported grammar), so the nearest one is offered with the error.
 */
export class LanzerLinker extends DefaultLinker {
    protected override createLinkingError(refInfo: ReferenceInfo, targetDescription?: AstNodeDescription): LinkingError {
        const error = super.createLinkingError(refInfo, targetDescription);
        let names: string[] = [];
        try {
            names = this.scopeProvider.getScope(refInfo).getAllElements().map((element) => element.name).toArray();
        } catch {
            // No scope to draw on; the plain error stands.
        }
        const suggestion = nearestName(refInfo.reference.$refText, names);
        return suggestion ? { ...error, message: `${error.message} Did you mean '${suggestion}'?` } : error;
    }
}
